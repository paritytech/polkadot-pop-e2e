import { Binary, type PolkadotClient } from "polkadot-api";
import { mergeUint8 } from "@polkadot-api/utils";
import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { fromPapi, GAME_ACCOUNT_INDEX, productContext, readScoreContext, type PersonhoodProver } from "@parity/product-sdk-individuality";
import { fetchRingMembers, LITE_PEOPLE_IDENTIFIER, ringExponent, takeRingSnapshot, type RingSnapshot } from "@pop-e2e/chain-tests/src/lib/ring.js";
import { deriveProductAccount, deriveProductSecret, identityKey, liteRingEntropy, type IdentityKey } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { verifiableFor } from "@pop-e2e/chain-tests/src/lib/verifiable-loader.js";
import { submitBurst } from "./burst.js";
import { derivePlayer, hostMnemonic, playerFromSecret, type Keypair, type Player } from "./keys.js";
import { dispatchAsRoot, fundPlayers } from "./root.js";
import type { SigningPool } from "./signing-pool.js";
import { bump } from "./stats.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { sleep } from "./time.js";

/**
 * The first bot index of the lite bots: far above the deposit-backed bots, whose hosts number
 * at most a few hundred, so a lite bot never shares a wallet with one of them.
 */
export const LITE_FIRST_INDEX = 100_000;

/** A bot with a wallet of its own, the way a phone holds one person: the lite person and the game account it plays with. */
export interface LiteBot {
  /** The game account, product account 0 of `dim2.<tld>`, which signs up and plays. */
  player: Player & { liteEntropy: Uint8Array };
  /** The identity account, product account 0 of `peopl.<tld>`, which the attester makes a lite person. */
  candidate: IdentityKey;
}

/**
 * Bot `index` of `seed`: the wallet of host `index` with one ghost each, so its game account is
 * the one truapi-host signs with for `--ghosts-per-host 1`. Every key follows from the seed and
 * index alone, so a later run finds the same lite people on chain.
 */
export function deriveLiteBot(seed: string, gameProduct: string, tld: string, index: number): LiteBot {
  const entropy = mnemonicToEntropy(hostMnemonic(seed, index));
  const game = deriveProductAccount(deriveProductSecret(entropy, gameProduct), GAME_ACCOUNT_INDEX);
  return {
    player: { ...playerFromSecret(index, game.secretKey), liteEntropy: liteRingEntropy(entropy, tld) },
    candidate: identityKey(entropy, tld),
  };
}

/** The account that attests a network's lite bots: derived from the seed, so the People team can grant it an allowance once. */
export function deriveAttester(seed: string): Player {
  return derivePlayer(`${seed}/attester`, 0);
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

/** The target's root key when it is the chain's `Sudo.Key`; undefined on a chain where the run can't dispatch as root. */
export async function readRootKey(api: PeopleApi, target: Target): Promise<Keypair | undefined> {
  if (!target.sudo) return undefined;
  const key = await api.query.Sudo.Key.getValue().catch(() => undefined);
  return key === target.sudo.address ? target.sudo : undefined;
}

/** Refuses lite bots on a network without a root key unless the run passes `--allow-live-lite`. */
export function requireLiteAllowed(target: Target, root: Keypair | undefined, allowLive: boolean): void {
  if (root || allowLive) return;
  throw new Error(
    `${target.label} has no root key here, so it is a live network: lite bots stay lite people there for good; pass --allow-live-lite once the People team has approved them`,
  );
}

/** `PeopleLite`'s registration message: the prefix, the candidate and its ring key, as `registration_message` encodes them. */
const REGISTRATION_PREFIX = new TextEncoder().encode("pop:people-lite:register using");

/** The signing context of `peopl.<suffix>`, `"sig/"` and 28 zero bytes as its suffix, which an account signs a message after. */
function signingContext(personhoodProduct: string): Uint8Array {
  const suffix = new Uint8Array(32);
  suffix.set(new TextEncoder().encode("sig/"));
  return productContext(personhoodProduct, { tag: "Raw", value: suffix });
}

/** Bots' `PeopleLite.attest` calls, signed by the attester from `nonce` on. */
function attestCalls(api: PeopleApi, bots: LiteBot[], personhoodProduct: string) {
  const verifiable = verifiableFor();
  const context = signingContext(personhoodProduct);
  return bots.map(({ player, candidate }) => {
    const ringKey = verifiable.member_from_entropy(player.liteEntropy);
    const message = mergeUint8([REGISTRATION_PREFIX, candidate.publicKey, ringKey]);
    return api.tx.PeopleLite.attest({
      candidate: candidate.address,
      candidate_signature: { type: "Sr25519", value: Binary.toHex(candidate.sign(mergeUint8([context, message]))) },
      ring_vrf_key: Binary.toHex(ringKey),
      proof_of_ownership: Binary.toHex(verifiable.sign(player.liteEntropy, message)),
      consumer_registration: undefined,
    });
  });
}

export interface ProvisionResult {
  bots: number;
  /** Lite people already, from an earlier run. */
  alreadyLite: number;
  /** Attestations that executed in this run. */
  attested: number;
  /** Attestations that didn't, by error. */
  failures: Record<string, number>;
  /** Bots whose lite key is in a ring root at the end. */
  inRing: number;
  /** From the start of the run to every bot in a ring, or to the inclusion timeout. */
  durationMs: number;
}

/** Attestations per burst: about one People block of `attest` calls at their weight. */
const ATTESTS_PER_BURST = 500;

/** The attester's balance for the fees `attest` refunds: 1 UNIT. */
const ATTESTER_FUNDS = 10_000_000_000n;

/**
 * Makes every bot a lite person: attests the bots that aren't one yet from `attester`, then waits
 * until every bot's lite key is in a ring root at the finalized block, so a rerun attests nothing
 * and only checks. With `root`, root first grants the attester the allowance and the balance it
 * lacks; without it, the attester has to have both already.
 */
export async function provisionLitePeople(
  target: Target,
  pool: SigningPool,
  bots: LiteBot[],
  options: { attester: Player; root: Keypair | undefined; connections: number; inclusionTimeoutMs: number },
): Promise<ProvisionResult> {
  const started = Date.now();
  const { client, api } = connectPeople(target);
  try {
    const score = await readScoreContext(fromPapi(client, api) as never);
    if (!score.ok) throw score.error;
    const personhoodProduct = score.value.productId;
    const lite = await api.query.PeopleLite.LitePeople.getValues(bots.map(({ candidate }) => [candidate.address]), { at: "best" });
    const pending = bots.filter((_, position) => lite[position] === undefined);
    console.log(`[people] ${bots.length} bots in ${personhoodProduct}: ${bots.length - pending.length} lite already, ${pending.length} to attest`);
    let attested = 0;
    const failures: Record<string, number> = {};
    if (pending.length > 0) {
      const { attester, root } = options;
      const allowance = (await api.query.PeopleLite.AttestationAllowance.getValue(attester.address, { at: "best" })) ?? 0;
      if (allowance < pending.length && !root) {
        throw new Error(
          `attester ${attester.address} may attest ${allowance} more lite people, ${pending.length} needed: People's root has to grant it with PeopleLite.increase_attestation_allowance`,
        );
      }
      if (allowance < pending.length) {
        await dispatchAsRoot(api, root!, [api.tx.PeopleLite.increase_attestation_allowance({ account: attester.address, count: pending.length - allowance }).decodedCall], 1, "allowance");
      }
      // `attest` costs no fee once it succeeds, but the pool takes the fee up front.
      if (root && (await api.query.System.Account.getValue(attester.address, { at: "best" })).data.free < ATTESTER_FUNDS) {
        await fundPlayers(api, root, [attester], ATTESTER_FUNDS);
      }
      const { nonce } = await api.query.System.Account.getValue(attester.address, { at: "best" });
      for (let start = 0; start < pending.length; start += ATTESTS_PER_BURST) {
        const chunk = pending.slice(start, start + ATTESTS_PER_BURST);
        const signed = await pool.sign(
          attestCalls(api, chunk, personhoodProduct).map((tx, position) => ({ player: attester, chain: "people" as const, signer: "account" as const, tx, nonce: nonce + start + position })),
          "attest",
        );
        const sent = await submitBurst(signed, api, client, target.rpc, options.connections, () => Number.MAX_SAFE_INTEGER);
        attested += sent.ok;
        for (const [failure, count] of Object.entries(sent.failures)) bump(failures, failure, count);
        console.log(`[people] attested ${Math.min(start + ATTESTS_PER_BURST, pending.length)}/${pending.length}: ${sent.ok}/${sent.submitted} ${JSON.stringify(sent.failures)}`);
      }
    }
    const inRing = await waitForRings(api, client, bots, options.inclusionTimeoutMs);
    return { bots: bots.length, alreadyLite: bots.length - pending.length, attested, failures, inRing, durationMs: Date.now() - started };
  } finally {
    client.destroy();
  }
}

/**
 * How many bots' lite keys are in a ring root at the finalized block, read again every 6 s until
 * all are or `timeoutMs` has passed. A key is `Included` a block before the ring's root contains
 * it, so a key counts once it is among the ring's included keys.
 */
async function waitForRings(api: PeopleApi, client: PolkadotClient, bots: LiteBot[], timeoutMs: number): Promise<number> {
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
    if (inRing === keys.length || Date.now() > until) return inRing;
    await sleep(6_000);
  }
}
