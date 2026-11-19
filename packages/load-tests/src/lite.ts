import { Binary, type PolkadotClient } from "polkadot-api";
import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { GAME_ACCOUNT_INDEX, productContext, type PersonhoodProver } from "@parity/product-sdk-individuality";
import { fetchRingMembers, LITE_PEOPLE_IDENTIFIER, ringExponent, takeRingSnapshot, type RingSnapshot } from "@pop-e2e/chain-tests/src/lib/ring.js";
import { deriveProductAccount, deriveProductSecret, identityKey, liteRingEntropy, type IdentityKey } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { verifiableFor } from "@pop-e2e/chain-tests/src/lib/verifiable-loader.js";
import { Histogram, type QuantileSummary } from "./histogram.js";
import { hostMnemonic, playerFromSecret, type Player } from "./keys.js";
import { bump, total } from "./stats.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { readAll, sleep } from "./time.js";

/**
 * The first bot index of the lite bots: far above the deposit-backed bots, whose hosts number
 * at most a few hundred, so a lite bot never shares a wallet with one of them.
 */
export const LITE_FIRST_INDEX = 100_000;

/** A bot with a wallet of its own, the way a phone holds one person: the lite person and the game account it plays with. */
export interface LiteBot {
  /** The wallet's mnemonic, which truapi-host attests as a phone's host does. */
  mnemonic: string;
  /** The game account, product account 0 of `dim2.<tld>`, which signs up and plays. */
  player: Player & { liteEntropy: Uint8Array };
  /** The identity account, product account 0 of `peopl.<tld>`, which DUB makes a lite person. */
  candidate: IdentityKey;
}

/**
 * Bot `index` of `seed`: the wallet of host `index` with one ghost each, so its game account is
 * the one truapi-host signs with for `--ghosts-per-host 1`. Every key follows from the seed and
 * index alone, so a later run finds the same lite people on chain.
 */
export function deriveLiteBot(seed: string, gameProduct: string, tld: string, index: number): LiteBot {
  const mnemonic = hostMnemonic(seed, index);
  const entropy = mnemonicToEntropy(mnemonic);
  const game = deriveProductAccount(deriveProductSecret(entropy, gameProduct), GAME_ACCOUNT_INDEX);
  return {
    mnemonic,
    player: { ...playerFromSecret(index, game.secretKey), liteEntropy: liteRingEntropy(entropy, tld) },
    candidate: identityKey(entropy, tld),
  };
}

const LITE_COLLECTION = Binary.toHex(LITE_PEOPLE_IDENTIFIER);

/** The ring a lite key is included in at block `at`, if any. */
async function readLiteRing(api: PeopleApi, memberKey: `0x${string}`, at: string): Promise<number | undefined> {
  const status = await api.query.Members.Members.getValue(LITE_COLLECTION, memberKey, { at });
  return status?.type === "Included" ? status.value.ring_index : undefined;
}

/**
 * The lite key of `liteEntropy` as a host's personhood keys: whether the lite ring holds it, and
 * proofs with it over that ring's members at the finalized block, which `snapshots` shares
 * between the bots of one process.
 */
export function litePersonhood(api: PeopleApi, client: PolkadotClient, liteEntropy: Uint8Array, snapshots: RingSnapshots): PersonhoodProver {
  const verifiable = verifiableFor();
  const memberKey = Binary.toHex(verifiable.member_from_entropy(liteEntropy)) as `0x${string}`;
  return {
    async holds(ring) {
      return ring.key === "lite" && (await readLiteRing(api, memberKey, (await client.getFinalizedBlock()).hash)) !== undefined;
    },
    async prove(ring, context, message) {
      if (ring.key !== "lite" || !("productId" in context) || context.suffix.tag !== "Index") {
        throw new Error(`a lite bot proves with its lite key in a product's indexed context, not ${ring.key} in ${JSON.stringify(context)}`);
      }
      const ringIndex = await readLiteRing(api, memberKey, (await client.getFinalizedBlock()).hash);
      if (ringIndex === undefined) throw new Error(`lite key ${memberKey} is in no ring at the finalized block`);
      const [snapshot, exponent] = await Promise.all([snapshots.read(ringIndex), snapshots.exponent()]);
      const contextBytes = productContext(context.productId, context.suffix);
      const { proof, alias } = verifiable.one_shot(exponent, liteEntropy, snapshot.encodedMembers, contextBytes, message);
      return { proof, contextualAlias: { context: contextBytes, alias }, ringIndex, ringRevision: snapshot.revisionIndex };
    },
  };
}

/** Lite ring members and revision at the latest finalized block, read once per block and ring however many bots prove. */
export class RingSnapshots {
  private readonly cache = new Map<number, Promise<RingSnapshot>>();
  private exponentRead: Promise<number> | undefined;

  constructor(
    private readonly api: PeopleApi,
    private readonly client: PolkadotClient,
  ) {}

  exponent(): Promise<number> {
    return (this.exponentRead ??= ringExponent(this.api, "LitePeople"));
  }

  async read(ringIndex: number): Promise<RingSnapshot> {
    const finalized = (await this.client.getFinalizedBlock()).hash;
    const cached = this.cache.get(ringIndex);
    if (cached && (await cached).at === finalized) return cached;
    const fresh = takeRingSnapshot(this.api, this.client, ringIndex);
    this.cache.set(ringIndex, fresh);
    fresh.catch(() => this.cache.delete(ringIndex));
    return fresh;
  }
}

export interface ProvisionResult {
  bots: number;
  /** Lite people already, from an earlier run. */
  alreadyLite: number;
  /** Attests that ended with the bot a ring member. */
  attested: number;
  /**
   * Attests the CLI gave up waiting on, for the dotNS name or the ring, or that ran out of time:
   * DUB may still finish them, so they count as lite once the chain shows them.
   */
  pending: number;
  /** Attests that DUB refused with 429 Too Many Requests, also counted in `failures`. */
  rateLimited: number;
  /** Attests that failed, by error: an HTTP status from DUB, or the CLI's message. */
  failures: Record<string, number>;
  /** From starting `truapi-host attest` to its exit, ring inclusion included, for the attests that succeeded. */
  attestMs: QuantileSummary;
  /** Bots whose lite key is in a ring root at the end. */
  inRing: number;
  /** From the start of the run to every bot in a ring, or to the inclusion timeout. */
  durationMs: number;
}

/** A lite username base: 6+ lowercase letters, which DUB extends to a unique username. */
const USERNAME_BASE = "loadbot";

/**
 * How an attest ended when `truapi-host attest` failed: `pending` when it stopped waiting for
 * work DUB still finishes (the dotNS name, ring membership, or its own time limit), else the
 * failure as a count key, DUB's HTTP status when the CLI reports one, else its first line.
 */
export function attestFailure(message: string): string {
  if (/\(killed after|dotNS username did not appear|did not appear in any personhood ring/.test(message)) return "pending";
  const status = /\(([45]\d\d) [A-Z]/.exec(message) ?? /\bstatus(?: code)?:? ([45]\d\d)\b/i.exec(message);
  if (status) return `HTTP ${status[1]}`;
  return (message.replace(/^\[truapi-host\] attest failed: /, "").split("\n")[0] ?? "").slice(0, 120);
}

/**
 * DUB's dotNS lane writes about 3 names per Asset Hub batch, waiting for finality between
 * batches: about 4.5 a minute, whatever the attests' concurrency.
 */
const ATTESTS_PER_MINUTE = 4.5;

/**
 * Makes every bot a lite person the way a phone becomes one: `truapi-host attest` through the
 * stack's identity backend (DUB), which attests the identity account, registers its lite
 * username and waits until the lite key is a ring member. Bots that are lite people already are
 * skipped, so a rerun, also of an interrupted run, attests only the rest. `concurrency` attests
 * run at once; then the chain is read until every bot not refused is in a ring root.
 */
export async function provisionLitePeople(
  target: Target,
  bots: LiteBot[],
  options: { concurrency: number; inclusionTimeoutMs: number },
): Promise<ProvisionResult> {
  const started = Date.now();
  // Deferred: the module reads the stack STACK or NETWORK selects when it loads.
  const { attest } = await import("@pop-e2e/chain-tests/src/lib/truapi-host.js");
  const { client, api } = connectPeople(target);
  try {
    const lite = await api.query.PeopleLite.LitePeople.getValues(bots.map(({ candidate }) => [candidate.address]), { at: "best" });
    const pending = bots.filter((_, position) => lite[position] === undefined);
    console.log(
      `[people] ${bots.length} bots: ${bots.length - pending.length} lite already, ${pending.length} to attest, ${options.concurrency} at a time, about ${Math.ceil(pending.length / ATTESTS_PER_MINUTE)} min at DUB's dotNS rate`,
    );
    const failures: Record<string, number> = {};
    const attestMs = new Histogram();
    let attested = 0;
    let waiting = 0;
    await readAll(
      pending,
      async (bot) => {
        const attestStarted = Date.now();
        const seconds = () => ((Date.now() - attestStarted) / 1000).toFixed(1);
        try {
          const identity = await attest(bot.mnemonic, USERNAME_BASE);
          if (identity.address !== bot.candidate.address) throw new Error(`attested ${identity.address}, not the bot's identity account ${bot.candidate.address}`);
          attestMs.add(Date.now() - attestStarted);
          attested++;
          console.log(`[people] bot ${bot.player.index}: ${identity.liteUsername} in ${seconds()} s`);
        } catch (error) {
          const outcome = attestFailure((error as Error).message);
          if (outcome === "pending") waiting++;
          else bump(failures, outcome);
          console.warn(`[people] bot ${bot.player.index}: ${outcome} after ${seconds()} s: ${(error as Error).message.slice(0, 300)}`);
        }
      },
      options.concurrency,
    );
    const refused = total(failures);
    const inRing = await waitForRings(api, client, bots, bots.length - refused, options.inclusionTimeoutMs);
    return {
      bots: bots.length,
      alreadyLite: bots.length - pending.length,
      attested,
      pending: waiting,
      rateLimited: failures["HTTP 429"] ?? 0,
      failures,
      attestMs: attestMs.summary(),
      inRing,
      durationMs: Date.now() - started,
    };
  } finally {
    client.destroy();
  }
}

/**
 * How many bots' lite keys are in a ring root at the finalized block, read again every 6 s until
 * `expected` are or `timeoutMs` has passed. A key is `Included` a block before the ring's root
 * contains it, so a key counts once it is among the ring's included keys.
 */
async function waitForRings(api: PeopleApi, client: PolkadotClient, bots: LiteBot[], expected: number, timeoutMs: number): Promise<number> {
  const { member_from_entropy } = verifiableFor();
  const keys = bots.map(({ player }) => Binary.toHex(member_from_entropy(player.liteEntropy)));
  const until = Date.now() + timeoutMs;
  let reported = -1;
  for (;;) {
    const at = (await client.getFinalizedBlock()).hash;
    const statuses = await api.query.Members.Members.getValues(keys.map((key) => [LITE_COLLECTION, key]), { at });
    const rings = new Set(statuses.flatMap((status) => (status?.type === "Included" ? [status.value.ring_index] : [])));
    const rootKeys = new Set<string>();
    for (const ring of rings) for (const key of await fetchRingMembers(api, "LitePeople", ring, at)) rootKeys.add(Binary.toHex(key));
    const inRing = keys.filter((key) => rootKeys.has(key)).length;
    if (inRing !== reported) console.log(`[people] ${inRing}/${keys.length} lite keys in a ring root at the finalized block`);
    reported = inRing;
    if (inRing >= expected || Date.now() > until) return inRing;
    await sleep(6_000);
  }
}
