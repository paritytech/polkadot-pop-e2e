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
 * `now - 60s` so we have headroom for clock drift in either direction and
 * still 240s of validity left when the extrinsic actually finalizes.
 *
 * ## Resilience
 *
 * Mirrors the lts-claim pattern (PR #85): fresh People-finalized
 * snapshot on every attempt, retry on transient Invalid-tx variants up
 * to `MAX_PROOF_ATTEMPTS`. The OCW can rebuild the LitePeople ring
 * mid-flight between snapshot and submit, in which case the chain
 * rejects with `Module::AliasAccounts::BadProof` even though the proof
 * itself is well-formed — re-snapshotting picks up the new revision and
 * the next attempt lands. Observed 2026-06-15 on paseo-next-v2 cron.
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

const MAX_PROOF_ATTEMPTS = 3;

/**
 * Match the Invalid-tx variants that *we know* can be transient on this
 * chain shape — anything else escapes the retry loop so a real bug
 * surfaces loud instead of being papered over.
 *
 *   - `BadProof` — pallet's ring-proof validate failed, almost always
 *     because the ring rebuilt between snapshot and submit (revision
 *     advanced past our proof's `ring_revision`).
 *   - `AncientBirthBlock` / `Future` — mortality era anchor no longer
 *     valid (re-org, slow tx propagation, big clock skew).
 *   - `Stale` — nonce / replay defence; a refreshed snapshot picks up
 *     the new nonce.
 */
function isRetryableInvalidTx(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /BadProof|AncientBirthBlock|Future|Stale/i.test(msg);
}

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
  attempts: number;
}

interface Snapshot {
  at: `0x${string}`;
  ringRevision: number;
  encodedMembers: Uint8Array;
  memberCount: number;
}

async function takeSnapshot(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  ringIndex: number,
): Promise<Snapshot> {
  const fin = await peopleClient.getFinalizedBlock();
  const at = fin.hash as `0x${string}`;
  const idHex = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
  const root = await peopleApi.query.Members.Root.getValue(idHex, ringIndex, { at });
  const ringRevision = root?.revision ?? 0;
  const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
  const encodedMembers = encodeMembers(memberKeys);
  return { at, ringRevision, encodedMembers, memberCount: memberKeys.length };
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
 *
 * Takes a fresh People-finalized snapshot per attempt and retries on
 * transient Invalid-tx variants (BadProof / AncientBirthBlock / Future
 * / Stale) up to MAX_PROOF_ATTEMPTS. The most common transient is
 * BadProof from a mid-flight ring rebuild — re-snapshotting picks up
 * the new revision and the next attempt lands.
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

  // Find the lite-person's ring assignment. Prefer the Ring Inclusion
  // probe's cached ring index — that part is stable for the account's
  // lifetime. The cached `at` is deliberately ignored; we always
  // re-snapshot (see file header).
  const location =
    getCachedRingLocation() ??
    (await waitForInclusion(args.peopleApi, "LitePeople", verifiableEntropy, {
      peopleClient: args.peopleClient,
    }));
  const ringIndex = location.ringIndex;

  // Derive the attested account's sr25519 keypair once — same key
  // across all retry attempts.
  const keyPair = deriveKeyPair(args.creds.entropy);
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

  const { one_shot } = verifiableFor();
  const ctxPreview = Binary.toHex(args.context).slice(0, 14);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
    const snap = await takeSnapshot(args.peopleApi, args.peopleClient, ringIndex);

    // Anchor `proof_valid_at` 60s before now per attempt. The runtime
    // requires proof_valid_at ≤ now_at_block ≤ proof_valid_at +
    // ProofValidityWindow. Refreshing per attempt absorbs clock drift
    // between attempts and keeps the 240s forward window healthy.
    const proofValidAt = BigInt(Math.floor(Date.now() / 1000) - 60);

    console.log(
      `[alias-claim] attempt=${attempt} ctx=${ctxPreview}… ring=${ringIndex} rev=${snap.ringRevision} ` +
        `members=${snap.memberCount} proof_valid_at=${proofValidAt} (people @${snap.at.slice(0, 10)}…)`,
    );

    const message = proofMessage(args.creds.publicKey, proofValidAt);
    const { proof, alias } = one_shot(
      verifiableEntropy,
      snap.encodedMembers,
      args.context,
      message,
    );

    const tx = args.assetHubApi.tx.AliasAccounts.set_alias_account({
      proof,
      collection: Binary.toHex(LITE_PEOPLE_IDENTIFIER),
      ring_index: ringIndex,
      ring_revision: snap.ringRevision,
      context: Binary.toHex(args.context),
      proof_valid_at: proofValidAt,
    });

    try {
      const result = await tx.signAndSubmit(signer);
      if (!result.ok) {
        throw new Error(
          `[alias-claim] set_alias_account failed: ${JSON.stringify(result.dispatchError)}`,
        );
      }
      const aliasHex = Binary.toHex(alias);
      console.log(
        `[alias-claim] attempt=${attempt} OK block=#${result.block.number} alias=${aliasHex.slice(0, 14)}…`,
      );

      return {
        ok: true,
        block: result.block.number,
        alias,
        ringIndex,
        ringRevision: snap.ringRevision,
        proofValidAt,
        attempts: attempt,
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryableInvalidTx(err) || attempt === MAX_PROOF_ATTEMPTS) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(
        `[alias-claim] attempt=${attempt} rejected (${errMsg.slice(0, 120)}); ` +
          `re-snapshotting + retrying`,
      );
    }
  }
  // Unreachable — the loop either returns or throws on the final attempt.
  throw lastErr ?? new Error("[alias-claim] exhausted retry budget");
}
