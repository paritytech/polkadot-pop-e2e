import {
  buildTurnProof,
  redeemTurnProof,
  turnPassFor,
  turnPassLeftMs,
  type TurnFetch,
  type TurnPass,
  type TurnProofBody,
  type TurnProofInputs,
  type TurnServer,
} from "@jollity/protocol";
import type { PersonhoodProver } from "@parity/product-sdk-individuality";
import { SigningPool } from "../signing-pool.js";
import { bump } from "../stats.js";
import { connectPeople, type Target } from "../target.js";
import { sleep } from "../time.js";
import { VideoStats } from "./stats.js";

/** Attempts per fetch, the waits before the second and the third, and the budget, as the app's `ice.ts`. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];
const RETRY_BUDGET_MS = 15_000;
/** A proof older than this is built again before it is posted. */
const PROOF_MAX_AGE_MS = 30_000;
/** The app's warm-up refreshes, before the game (`use-turn-warmup.ts`). */
const REFRESH_BEFORE_GAME_MS = [10 * 60_000, 3 * 60_000];
/** A refresh replaces only a pass with less than this left (the app's `REFRESH_BELOW_S`, `ice.ts`). */
const REFRESH_BELOW_MS = 600_000;

/** What every bot's proof shares: the product, the People genesis, the ring collections and the hash. */
export type TurnProofSetup = Omit<TurnProofInputs, "timestamp" | "describe">;

export interface TurnIssuer {
  /** The device-uniqueness backend that issues TURN credentials for a personhood proof. */
  base: string;
  fetch: TurnFetch;
}

export type TurnProof = { body: TurnProofBody; at: number };

/** A proof of the current second, with the time building it took; or the step that stopped it. */
export type TurnProofOutcome = { proof: TurnProof; ms: number } | { code: string };

/** One bot's proof of the current second, made on whichever thread has its key. */
export type ProveTurn = () => Promise<TurnProofOutcome>;

/** A ring-VRF proof of the current second with `prover`'s lite key. */
export async function proveTurnNow(prover: PersonhoodProver, setup: TurnProofSetup): Promise<TurnProofOutcome> {
  const at = Date.now();
  const result = await buildTurnProof(prover, { ...setup, timestamp: Math.floor(at / 1000) });
  return "code" in result ? { code: result.code } : { proof: { body: result.body, at }, ms: Date.now() - at };
}

/**
 * Runs the proofs handed to it one after another. A proof takes its timestamp when it starts, so
 * a worker thread with several TURN jobs posts each proof a single proof's time after its stamp,
 * however many wait behind it.
 */
export function createProofQueue(): (prove: ProveTurn) => Promise<TurnProofOutcome> {
  let previous: Promise<unknown> = Promise.resolve();
  return (prove) => {
    const next = previous.then(prove, prove);
    previous = next.catch(() => {});
    return next;
  };
}

/**
 * One bot's TURN credentials as the app fetches them: `proof`, or a new one, posted to the
 * issuer, up to three attempts with backoff for a timeout, a 5xx or a refused timestamp. A proof
 * 30 s old or with a refused timestamp is built again before it is posted. A 403, a 429 or another
 * 400 ends the fetch. Every attempt is counted in `stats` by outcome, with the proof's and the
 * issuer's time.
 */
export async function fetchTurnPass(proveTurn: ProveTurn, issuer: TurnIssuer, stats: VideoStats, proof?: TurnProof): Promise<TurnPass | undefined> {
  const prove = async (): Promise<TurnProof | undefined> => {
    const outcome = await proveTurn();
    if ("code" in outcome) {
      bump(stats.turnFetches, `proof ${outcome.code}`);
      return undefined;
    }
    stats.turnProofMs.add(outcome.ms);
    return outcome.proof;
  };
  const startTime = Date.now();
  for (let attempt = 1; ; attempt++) {
    if (!proof || Date.now() - proof.at > PROOF_MAX_AGE_MS) proof = await prove();
    if (!proof) return undefined;
    const postTime = Date.now();
    const result = await redeemTurnProof(issuer.fetch, issuer.base, proof.body);
    stats.turnIssuerMs.add(Date.now() - postTime);
    if ("credentials" in result) {
      bump(stats.turnFetches, "ok");
      return turnPassFor(result.credentials, Date.now());
    }
    bump(stats.turnFetches, `${result.cause}${result.status ? ` ${result.status}` : ""}`);
    if (result.cause === "timestamp-window") proof = undefined;
    const retryable = result.cause === "timeout" || result.cause === "server-error" || result.cause === "no-ring-roots" || result.cause === "timestamp-window";
    const wait = BACKOFF_MS[attempt - 1] * (0.75 + Math.random() * 0.5);
    if (!retryable || attempt >= MAX_ATTEMPTS || Date.now() - startTime + wait > RETRY_BUDGET_MS) return undefined;
    await sleep(wait);
  }
}

/**
 * The TURN passes of the lite bots in `provers`, fetched when the app fetches them: as soon as the bot
 * knows of its game, then 10 and 3 minutes before the game for a pass with under 10 minutes
 * left. After a failed refresh the previous pass stays in use while it is valid.
 */
export class TurnPasses {
  private readonly passes = new Map<number, TurnPass>();
  private readonly timers: NodeJS.Timeout[] = [];
  /** Fetch counts by bot, so each bot's land in its group. */
  private stats = new Map<number, VideoStats>();
  private fetching: Promise<void> = Promise.resolve();

  constructor(
    private readonly provers: Map<number, ProveTurn>,
    private readonly issuer: TurnIssuer,
  ) {}

  /** Fetches every bot's pass now and schedules the refreshes before the game at `gameAt`. */
  warm(gameAt: number): Promise<void> {
    for (const before of REFRESH_BEFORE_GAME_MS) {
      const delay = gameAt - before - Date.now();
      if (delay > 0) this.timers.push(setTimeout(() => void this.fetchAll(), delay));
    }
    return this.fetchAll();
  }

  /** The TURN servers of bot `index`, from its latest pass that is still valid. */
  serversOf(index: number): TurnServer[] {
    const pass = this.passes.get(index);
    return pass && turnPassLeftMs(pass, Date.now()) > 0 ? pass.turn : [];
  }

  /** Adds each bot's fetch counts since the last call to `statsOf(index)`, so each step's results contain each fetch once. */
  takeStats(statsOf: (index: number) => VideoStats): void {
    for (const [index, stats] of this.stats) statsOf(index).add(stats);
    this.stats = new Map();
  }

  stop(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  /** Every due bot proves and posts at once: each proof is built right before its post. */
  private fetchAll(): Promise<void> {
    this.fetching = this.fetching.then(async () => {
      const due = [...this.provers].filter(([index]) => {
        const pass = this.passes.get(index);
        return !pass || turnPassLeftMs(pass, Date.now()) < REFRESH_BELOW_MS;
      });
      await Promise.all(
        due.map(async ([index, prove]) => {
          const stats = this.stats.get(index) ?? this.stats.set(index, new VideoStats()).get(index)!;
          const pass = await fetchTurnPass(prove, this.issuer, stats);
          if (pass) this.passes.set(index, pass);
        }),
      );
    });
    return this.fetching;
  }
}

/**
 * TURN passes for the lite bots of `liteEntropies`, by player index, proved with each bot's lite
 * key over the lite ring at People's finalized block on one worker thread per core, from the
 * issuer at `issuerBase`. `close` ends the worker threads.
 */
export async function openLiteTurnPasses(
  target: Target,
  liteEntropies: Map<number, Uint8Array>,
  productId: string,
  issuerBase: string,
): Promise<{ passes: TurnPasses; close(): void }> {
  const { client } = connectPeople(target);
  const { genesisHash } = await client.getChainSpecData().finally(() => client.destroy());
  const pool = SigningPool.open(target);
  const genesis = genesisHash as `0x${string}`;
  const provers = new Map([...liteEntropies].map(([index, entropy]): [number, ProveTurn] => [index, () => pool.proveTurn(entropy, productId, genesis)]));
  const passes = new TurnPasses(provers, { base: issuerBase, fetch });
  return {
    passes,
    close() {
      passes.stop();
      void pool.close();
    },
  };
}
