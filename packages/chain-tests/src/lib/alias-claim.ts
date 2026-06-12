/**
 * Register a Lite-Person ring alias on Asset Hub via
 * `AliasAccounts.set_alias_account` (paritytech/individuality #878 +
 * #955 unified the original paid/free split into a single path; both
 * paseo-next-v2 and previewnet now run this version).
 *
 * After registration, smart contracts can call the on-chain Personhood
 * precompile with `(account, context)` and receive `{ status, alias }` —
 * the per-context pseudonym the human picked when registering. The
 * same physical human registering for a different `context` produces a
 * different alias (one-way derived from `(entropy, context)`), which
 * is the cross-app unlinkability property the Persons stack guarantees.
 *
 * Unlike PGAS/LTS/StmtStore (which encode the proof inside a tx
 * extension on a v5 general transaction), this extrinsic carries the
 * proof as a regular call argument and is submitted with a normal
 * signed extrinsic. The signer pays `AliasFee` in PGAS and becomes
 * the bound account.
 *
 * Proof binding (matches the deployed pallet's `proof_message`):
 *   message = blake2_256(b"alias-accounts" || account_pubkey_32 || proof_valid_at_u64_LE)
 *   proof   = ring_vrf.one_shot(entropy, members, context, message)
 *
 * `proof_valid_at` must satisfy: `proof_valid_at ≤ now ≤ proof_valid_at + ProofValidityWindow`
 * The window is `300s` on paseo-next-v2; we anchor `proof_valid_at` to
 * `now - 5s` so we have headroom for clock drift in either direction and
 * still 295s of validity left when the extrinsic actually finalizes.
 */
import { Binary, type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { mergeUint8 } from "@polkadot-api/utils";
import { verifiableFor } from "./verifiable-loader.js";
import {
  encodeMembers,
  fetchRingMembers,
  LITE_PEOPLE_IDENTIFIER,
  waitForInclusion,
} from "./ring.js";
import { getCachedRingLocation } from "./ring-cascade.js";
import { deriveKeyPair } from "./attestation.js";
import type { PeopleApi, RichAssetHubApi } from "./client.js";
import type { AttestedCredentials } from "./credentials.js";

const PROOF_PREFIX = new TextEncoder().encode("alias-accounts"); // 14 bytes

/**
 * Compute the proof message the alias-accounts pallet expects. Mirrors
 * the deployed runtime's `proof_message`:
 *
 *   blake2_256(SCALE::encode((b"alias-accounts", AccountId32, u64)))
 *
 * `b"alias-accounts"` is `&[u8; 14]` (encodes to its 14 raw bytes),
 * `AccountId32` is `[u8; 32]` (encodes to 32 raw bytes), and `u64`
 * SCALE-encodes little-endian to 8 bytes. Total pre-image = 54 bytes.
 */
export function proofMessage(
  accountPublicKey: Uint8Array,
  proofValidAt: bigint,
): Uint8Array {
  if (accountPublicKey.length !== 32) {
    throw new Error(
      `Expected 32-byte account public key, got ${accountPublicKey.length}`,
    );
  }
  const validAtBytes = new Uint8Array(8);
  new DataView(validAtBytes.buffer).setBigUint64(0, proofValidAt, true); // LE
  return blake2b256(mergeUint8([PROOF_PREFIX, accountPublicKey, validAtBytes]));
}

/**
 * Build a 32-byte context from an ASCII label, zero-padded. Pick a
 * stable, namespaced label per app (e.g. `"triangle-e2e:pop-counter"`)
 * so the alias derivation doesn't collide with any other app's
 * registrations for the same person.
 */
export function customAliasContext(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) {
    throw new Error(`context label too long: ${bytes.length} bytes, max 32`);
  }
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

export interface SetAliasResult {
  ok: boolean;
  block?: number;
  /** 32-byte alias derived from `(entropy, context)`. Stable per (person, context). */
  alias: Uint8Array;
  ringIndex: number;
  ringRevision: number;
  proofValidAt: bigint;
}

/**
 * Register the attested account as the bound account for `context`
 * under LitePeople. Burns `AliasFee` PGAS from the signer.
 *
 * Preconditions:
 *   - `creds` is a Lite Person whose key is `Included` in a LitePeople
 *     ring on People chain. Use `ensureAttested()` upstream.
 *   - The latest ring revision is XCM-mirrored to AH's
 *     `MembersSubscriber.RingRoots` window — caller is responsible for
 *     waiting on AH ring sync (`waitForAssetHubRing` in allowances tests).
 *   - The signer holds enough PGAS for `AliasFee` (~1000 planck on
 *     paseo-next-v2; effectively free).
 */
export async function setAliasAccount(args: {
  peopleApi: PeopleApi;
  peopleClient: PolkadotClient;
  assetHubApi: RichAssetHubApi;
  creds: Pick<AttestedCredentials, "address" | "entropy" | "publicKey">;
  /** 32-byte context (build with `customAliasContext("...")`). */
  context: Uint8Array;
}): Promise<SetAliasResult> {
  if (args.context.length !== 32) {
    throw new Error(`context must be 32 bytes, got ${args.context.length}`);
  }

  const verifiableEntropy = blake2b256(args.creds.entropy);

  // Find the lite-person's ring assignment (which ring index they live
  // in). Prefer the Ring Inclusion probe's cached result for the
  // ringIndex — that part is stable. We deliberately ignore the cached
  // `at` here: the runtime's `is_revision_in_grace` rejects revisions
  // that are no longer the current one once `CleanupGracePeriod` has
  // elapsed since the revision was committed. So we always re-snapshot
  // against the latest People-finalized block, which carries the
  // current revision.
  const location =
    getCachedRingLocation() ??
    (await waitForInclusion(args.peopleApi, "LitePeople", verifiableEntropy, {
      peopleClient: args.peopleClient,
    }));
  const ringIndex = location.ringIndex;

  // Fresh snapshot at the latest People-finalized block. Pin every
  // subsequent read to this exact hash so members + revision stay
  // consistent across a possible ring rebuild mid-call.
  const fin = await args.peopleClient.getFinalizedBlock();
  const at = fin.hash;
  const idHex = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
  const root = await args.peopleApi.query.Members.Root.getValue(idHex, ringIndex, { at });
  const ringRevision = root?.revision ?? 0;
  const memberKeys = await fetchRingMembers(args.peopleApi, "LitePeople", ringIndex, at);
  const encodedMembers = encodeMembers(memberKeys);

  // Anchor `proof_valid_at` 60s before now. The runtime requires
  //   proof_valid_at ≤ now_at_block ≤ proof_valid_at + ProofValidityWindow
  // The chain's `UnixTime::now()` is the latest block timestamp, which
  // can lag wall-clock by a few seconds (parachain block time is 2s,
  // plus any catch-up jitter). Anchoring 60s in the past tolerates
  // up to a minute of drift while still leaving 240s of forward
  // window for tx propagation + finalization. Cast to bigint
  // because the descriptor types `proof_valid_at` as u64 → bigint.
  const proofValidAt = BigInt(Math.floor(Date.now() / 1000) - 60);

  const ctxPreview = Binary.toHex(args.context).slice(0, 14);
  console.log(
    `[alias-claim] ctx=${ctxPreview}… ring=${ringIndex} rev=${ringRevision} ` +
      `proof_valid_at=${proofValidAt} (people @${at.slice(0, 10)}…)`,
  );

  const message = proofMessage(args.creds.publicKey, proofValidAt);
  const { one_shot } = verifiableFor();
  const { proof, alias } = one_shot(
    verifiableEntropy,
    encodedMembers,
    args.context,
    message,
  );

  // Sign with the attested account's sr25519 key — same key the PGAS
  // test uses, so it already holds (or just minted) enough PGAS to
  // pay `AliasFee`.
  const keyPair = deriveKeyPair(args.creds.entropy);
  // Sanity: the public key the runtime sees as `who` must equal the
  // one we baked into proof_message. Diverging here would mean creds
  // and keypair drifted, e.g. across an attestation derivation
  // change.
  if (Binary.toHex(keyPair.publicKey) !== Binary.toHex(args.creds.publicKey)) {
    throw new Error(
      `[alias-claim] keypair pubkey ${Binary.toHex(keyPair.publicKey)} != creds.publicKey ${Binary.toHex(args.creds.publicKey)}`,
    );
  }
  const signer = getPolkadotSigner(
    keyPair.publicKey,
    "Sr25519",
    async (input) => keyPair.sign(input),
  );

  const tx = args.assetHubApi.tx.AliasAccounts.set_alias_account({
    proof,
    collection: Binary.toHex(LITE_PEOPLE_IDENTIFIER),
    ring_index: ringIndex,
    ring_revision: ringRevision,
    context: Binary.toHex(args.context),
    proof_valid_at: proofValidAt,
  });

  // Caller is responsible for ensuring the signer has enough native
  // PAS to cover the outer tx fee. Revive-auto-PGAS routing only kicks
  // in for `RuntimeCall::Revive(..)`; a regular AliasAccounts call
  // pays through `ChargeAssetTxPayment` which defaults to native.
  const result = await tx.signAndSubmit(signer);
  if (!result.ok) {
    throw new Error(
      `[alias-claim] set_alias_account failed: ${JSON.stringify(result.dispatchError)}`,
    );
  }
  const aliasHex = Binary.toHex(alias);
  console.log(
    `[alias-claim] OK block=#${result.block.number} alias=${aliasHex.slice(0, 14)}…`,
  );

  return {
    ok: true,
    block: result.block.number,
    alias,
    ringIndex,
    ringRevision,
    proofValidAt,
  };
}
