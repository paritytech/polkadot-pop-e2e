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
 * retry on the `InvalidTransaction::*` variants ring eviction or replay
 * checks can produce (BadProof, Future, Stale).
 */
import { type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { asResources, createClaimSigner } from "./claim-signer.js";
import { isRetryableInvalidTx, submitPeopleClaim } from "./people-claim.js";
import type { PeopleApi } from "./client.js";
import { ringExponent, takeRingSnapshot, waitForInclusion } from "./ring.js";
import { getCachedRingLocation } from "./ring-cascade.js";
import { longTermStorageContextV012, productContextSuffix } from "./individuality-compat.js";
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
 * Submit a long-term-storage allowance claim for `creds.address`.
 *
 * Uses the cached ring-index from Ring Inclusion (stable for the
 * account's lifetime), but takes a FRESH People-finalized snapshot of
 * (members, revision) on every attempt. Retries on the Invalid-tx variants
 * `isRetryableInvalidTx` accepts, up to 3 times.
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
  const suffix = await productContextSuffix(peopleClient);
  const context = suffix
    ? longTermStorageContextV012(suffix, period, counter)
    : longTermStorageContext(period, counter);

  const exponent = await ringExponent(peopleApi, "LitePeople");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PROOF_ATTEMPTS; attempt++) {
    const snap = await takeRingSnapshot(peopleApi, peopleClient, ringIndex);
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
      ringExponent: exponent,
      extensionValue: asResources("ClaimLongTermStorage", {
        ringIndex: snap.ringIndex,
        revision: snap.revisionIndex,
        collection: "LitePeople",
      }),
    });

    const tx = peopleApi.tx.Resources.claim_long_term_storage({
      period,
      counter,
      account_id: creds.address,
    });

    try {
      const finalized = await submitPeopleClaim(tx, signer);
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
