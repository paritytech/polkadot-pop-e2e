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
import { ringCollectionId, type PersonhoodProver } from "@parity/product-sdk-individuality";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { litePersonhood, RingSnapshots, type LiteBot } from "../lite.js";
import { bump } from "../stats.js";
import { connectPeople, type Target } from "../target.js";
import { sleep } from "../time.js";
import { VideoStats } from "./stats.js";

/** Tries per fetch, the waits before the second and the third, and the budget, as the app's `ice.ts`. */
const MAX_TRIES = 3;
const BACKOFF_MS = [1_000, 2_000];
const RETRY_BUDGET_MS = 15_000;
/** A proof older than this is built again before a retry. */
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

type TurnProof = { body: TurnProofBody; at: number };

/** A ring-VRF proof of the current second with the bot's lite key, or none after counting why. */
async function proveTurn(prover: PersonhoodProver, setup: TurnProofSetup, stats: VideoStats): Promise<TurnProof | undefined> {
  const at = Date.now();
  const built = await buildTurnProof(prover, { ...setup, timestamp: Math.floor(at / 1000) });
  stats.turnProofMs.add(Date.now() - at);
  if (!("code" in built)) return { body: built.body, at };
  bump(stats.turnFetches, `proof ${built.code}`);
  return undefined;
}

/**
 * One bot's TURN credentials as the app fetches them: `proof`, or a new one, posted to the
 * issuer, up to three tries with backoff for a timeout, a 5xx or a refused timestamp, proved again
 * before a try once the proof is 30 s old or its timestamp was refused. A 403, a 429 or another
 * 400 ends the fetch. Every try is counted in `stats` by outcome, with the issuer's answer time.
 */
export async function fetchTurnPass(
  prover: PersonhoodProver,
  setup: TurnProofSetup,
  issuer: TurnIssuer,
  stats: VideoStats,
  proof?: TurnProof,
): Promise<TurnPass | undefined> {
  const startedAt = Date.now();
  for (let tries = 1; ; tries++) {
    if (!proof || (tries > 1 && Date.now() - proof.at > PROOF_MAX_AGE_MS)) proof = await proveTurn(prover, setup, stats);
    if (!proof) return undefined;
    const postedAt = Date.now();
    const result = await redeemTurnProof(issuer.fetch, issuer.base, proof.body);
    stats.turnIssuerMs.add(Date.now() - postedAt);
    if ("credentials" in result) {
      bump(stats.turnFetches, "ok");
      return turnPassFor(result.credentials, Date.now());
    }
    bump(stats.turnFetches, `${result.cause}${result.status ? ` ${result.status}` : ""}`);
    if (result.cause === "timestamp-window") proof = undefined;
    const retryable = result.cause === "timeout" || result.cause === "server-error" || result.cause === "no-ring-roots" || result.cause === "timestamp-window";
    const wait = BACKOFF_MS[tries - 1] * (0.75 + Math.random() * 0.5);
    if (!retryable || tries >= MAX_TRIES || Date.now() - startedAt + wait > RETRY_BUDGET_MS) return undefined;
    await sleep(wait);
  }
}

/**
 * The TURN passes of a run's lite bots, fetched when the app fetches them: as soon as the bot
 * knows of its game, then 10 and 3 minutes before the game for a pass with under 10 minutes
 * left. A failed refresh keeps the pass it replaces while that one is valid.
 */
export class TurnPasses {
  private readonly passes = new Map<number, TurnPass>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stats = new VideoStats();
  private fetching: Promise<void> = Promise.resolve();

  constructor(
    private readonly provers: Map<number, PersonhoodProver>,
    private readonly setup: TurnProofSetup,
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

  /** The fetch counts since the last call, so each step's results contain each fetch once. */
  takeStats(): VideoStats {
    const taken = this.stats;
    this.stats = new VideoStats();
    return taken;
  }

  stop(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  private fetchAll(): Promise<void> {
    this.fetching = this.fetching.then(async () => {
      const due = [...this.provers].filter(([index]) => {
        const pass = this.passes.get(index);
        return !pass || turnPassLeftMs(pass, Date.now()) < REFRESH_BELOW_MS;
      });
      // Ring-VRF proofs block this thread: all of them go before the first request, so none delays
      // reading an issuer's answer and the issuer times stay the issuer's own.
      const proofs: Array<{ index: number; prover: PersonhoodProver; proof: TurnProof | undefined }> = [];
      for (const [index, prover] of due) proofs.push({ index, prover, proof: await proveTurn(prover, this.setup, this.stats) });
      await Promise.all(
        proofs.map(async ({ index, prover, proof }) => {
          const pass = proof && (await fetchTurnPass(prover, this.setup, this.issuer, this.stats, proof));
          if (pass) this.passes.set(index, pass);
        }),
      );
    });
    return this.fetching;
  }
}

/**
 * TURN passes for `bots` by player index, proved with each bot's lite key over the lite ring at
 * People's finalized block, from the issuer at `issuerBase`. `close` ends the People connection.
 */
export async function openLiteTurnPasses(target: Target, bots: Map<number, LiteBot>, productId: string, issuerBase: string): Promise<{ passes: TurnPasses; close(): void }> {
  const { client, api } = connectPeople(target);
  const snapshots = new RingSnapshots(api, client);
  const provers = new Map([...bots].map(([index, bot]) => [index, litePersonhood(api, client, bot.player.liteEntropy, snapshots)]));
  const { genesisHash } = await client.getChainSpecData();
  const setup: TurnProofSetup = { productId, genesis: genesisHash as `0x${string}`, collectionId: ringCollectionId, hash: blake2b256 };
  const passes = new TurnPasses(provers, setup, { base: issuerBase, fetch });
  return {
    passes,
    close() {
      passes.stop();
      client.destroy();
    },
  };
}
