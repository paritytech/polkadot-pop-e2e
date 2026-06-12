/**
 * Lite-person LTS allowance claim — moved out of allowances.test.ts
 * since storage.test.ts is the only consumer (the allowance authorizes
 * uploads on Bulletin via XCM dispatched from People chain).
 *
 * Submits an unsigned v5 general transaction to People chain with
 * `Resources.claim_long_term_storage(period, counter, account_id)` and
 * the `AsResources` extension carrying a ring-VRF proof. On success the
 * People chain runtime sends `TransactionStorage.AuthorizeAccount` to
 * Bulletin via XCM.
 *
 * ## Resilience
 *
 * We do NOT reuse the cached ring location from the Ring Inclusion
 * probe for the proof snapshot. That cache holds a People-finalized
 * hash that's typically 2-5 minutes stale by the time storage's
 * `beforeAll` runs, which puts our chosen revision near or past the
 * pallet's `CleanupGracePeriod`. Result: AsResources's validate step
 * returns `InvalidTransaction::BadProof` even though the proof itself
 * is well-formed.
 *
 * Symptom observed twice on paseo-next-v2 on 2026-06-12 (~3am, ~12pm
 * UTC) — `Storage: Bulletin Chain` flipped failed/passed across
 * consecutive health-check runs, matching the eviction-race signature
 * documented on `pallets/alias-accounts/src/lib.rs:is_revision_in_grace`.
 *
 * Fix: take a fresh People-finalized snapshot for every attempt, and
 * retry on any `InvalidTransaction::*` that mortality drift or ring
 * eviction can produce (BadProof, AncientBirthBlock, Future, Stale).
 */
import { Binary, type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import {
  createClaimSigner,
  encodeClaimLongTermStorage,
} from "./claim-signer.js";
import type { PeopleApi } from "./client.js";
import {
  encodeMembers,
  fetchRingMembers,
  LITE_PEOPLE_IDENTIFIER,
  waitForInclusion,
} from "./ring.js";
import { getCachedRingLocation } from "./ring-cascade.js";
import {
  longTermStorageContext,
  longTermStoragePeriodFromTimestamp,
} from "./allowances.js";
import type { AttestedCredentials } from "./credentials.js";

export interface LtsClaimResult {
  ok: boolean;
  block?: number;
  period: number;
  attempts: number;
}

const MAX_PROOF_ATTEMPTS = 3;

/**
 * Match the Invalid-tx variants that *we know* can be transient on this
 * chain shape — anything else escapes the retry loop so a real bug
 * surfaces loud instead of being papered over.
 *
 *   - `BadProof` — AsResources extension's ring-proof validate failed,
 *     almost always because our snapshot's revision is past grace.
 *   - `AncientBirthBlock` / `Future` — mortality era anchor is no
 *     longer valid (re-org, slow tx propagation, big clock skew).
 *   - `Stale` — nonce / replay defence; refreshing the snapshot picks
 *     up the new nonce.
 */
function isRetryableInvalidTx(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /BadProof|AncientBirthBlock|Future|Stale/i.test(msg);
}

interface Snapshot {
  at: `0x${string}`;
  ringIndex: number;
  revisionIndex: number;
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
  const revisionIndex = root?.revision ?? 0;
  const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
  const encodedMembers = encodeMembers(memberKeys);
  return { at, ringIndex, revisionIndex, encodedMembers, memberCount: memberKeys.length };
}

/**
 * Submit a long-term-storage allowance claim for `creds.address`.
 *
 * Uses the cached ring-index from Ring Inclusion (stable for the
 * account's lifetime), but takes a FRESH People-finalized snapshot of
 * (members, revision) on every attempt. Retries on `BadProof` and the
 * mortality-related Invalid-tx variants up to 3 times.
 */
export async function claimLongTermStorage(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  creds: Pick<AttestedCredentials, "address" | "entropy">,
  counter = 0,
): Promise<LtsClaimResult> {
  const verifiableEntropy = blake2b256(creds.entropy);

  // Use the cached ring assignment for the ring index only — that part is
  // stable. The cached `at` is deliberately ignored: see file header.
  const location =
    getCachedRingLocation() ??
    (await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, {
      peopleClient,
    }));
  const ringIndex = location.ringIndex;

  const periodDurationSecs = Number(
    await peopleApi.constants.Resources.LongTermStoragePeriodDuration(),
  );
  const period = longTermStoragePeriodFromTimestamp(
    Math.floor(Date.now() / 1000),
    periodDurationSecs,
  );
  const context = longTermStorageContext(period, counter);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
    const snap = await takeSnapshot(peopleApi, peopleClient, ringIndex);
    console.log(
      `[lts-claim] attempt=${attempt} period=${period} counter=${counter} ` +
        `ring=${snap.ringIndex} rev=${snap.revisionIndex} members=${snap.memberCount} ` +
        `(snapshot @${snap.at.slice(0, 10)}…)`,
    );

    const signer = createClaimSigner({
      extensionName: "AsResources",
      context,
      verifiableEntropy,
      encodedMembers: snap.encodedMembers,
      encodeExtensionValue: (proof) =>
        encodeClaimLongTermStorage({
          proof,
          ringIndex: snap.ringIndex,
          revisionIndex: snap.revisionIndex,
          litePeople: true,
        }),
    });

    const tx = peopleApi.tx.Resources.claim_long_term_storage({
      period,
      counter,
      account_id: creds.address,
    });

    // Passthrough values for the People chain's metadata-visible extensions;
    // the signer overrides AsResources with the proof-bearing payload.
    const customSignedExtensions = {
      VerifyMultiSignature: { value: { type: "Disabled" as const, value: undefined } },
      AsPerson: { value: undefined },
      AsProofOfInkParticipant: { value: undefined },
      ScoreAsParticipant: { value: undefined },
      GameAsInvited: { value: undefined },
      PeopleLiteAuth: { value: undefined },
      AsMember: { value: undefined },
      AsCoinage: { value: undefined },
      AsResources: { value: undefined },
      RestrictOrigins: { value: false },
    };

    try {
      const result = await tx.signSubmitAndWatch(signer, { customSignedExtensions });
      const finalized = await new Promise<{ ok: boolean; block?: number }>((resolve, reject) => {
        let lastBlock: number | undefined;
        result.subscribe({
          next: (e: { type: string; ok?: boolean; block?: { number: number } }) => {
            if (e.block) lastBlock = e.block.number;
            if (e.type === "finalized") {
              resolve({ ok: !!e.ok, block: lastBlock });
            }
          },
          error: reject,
        });
      });
      console.log(
        `[lts-claim] attempt=${attempt} ok=${finalized.ok} block=#${finalized.block ?? "?"} ` +
          `rev=${snap.revisionIndex}`,
      );
      return { ok: finalized.ok, block: finalized.block, period, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!isRetryableInvalidTx(err) || attempt === MAX_PROOF_ATTEMPTS) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(
        `[lts-claim] attempt=${attempt} rejected (${errMsg.slice(0, 80)}); ` +
          `re-snapshotting + retrying`,
      );
    }
  }
  // Unreachable — the loop either returns or throws on the final attempt.
  throw lastErr ?? new Error("[lts-claim] exhausted retry budget");
}
