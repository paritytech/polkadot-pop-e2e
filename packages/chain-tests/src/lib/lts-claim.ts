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
import {
  longTermStorageContext,
  longTermStoragePeriodFromTimestamp,
} from "./allowances.js";
import type { AttestedCredentials } from "./credentials.js";

export interface LtsClaimResult {
  ok: boolean;
  block?: number;
  period: number;
}

/**
 * Submit a long-term-storage allowance claim for `creds.address`.
 * Pins members + revision to a single finalized block to keep them
 * atomic w.r.t. ring rebuilds.
 */
export async function claimLongTermStorage(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  creds: Pick<AttestedCredentials, "address" | "entropy">,
  counter = 0,
): Promise<LtsClaimResult> {
  const verifiableEntropy = blake2b256(creds.entropy);
  const location = await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, {
    peopleClient,
  });
  const ringIndex = location.ringIndex;
  // Reuse the same finalized hash that confirmed inclusion. Re-reading
  // `getFinalizedBlock()` here would race past a ring rebuild and bump
  // the revision, which yields BadProof on submission.
  const at = location.at;

  const periodDurationSecs = Number(
    await peopleApi.constants.Resources.LongTermStoragePeriodDuration(),
  );
  const period = longTermStoragePeriodFromTimestamp(
    Math.floor(Date.now() / 1000),
    periodDurationSecs,
  );

  const idHex = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
  const root = await peopleApi.query.Members.Root.getValue(idHex, ringIndex, { at });
  const revisionIndex = root?.revision ?? 0;
  console.log(
    `[lts-claim] period=${period} counter=${counter} ring=${ringIndex} rev=${revisionIndex} (snapshot @${at.slice(0, 10)}…)`,
  );

  const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
  const encodedMembers = encodeMembers(memberKeys);
  const context = longTermStorageContext(period, counter);

  const signer = createClaimSigner({
    extensionName: "AsResources",
    context,
    verifiableEntropy,
    encodedMembers,
    encodeExtensionValue: (proof) =>
      encodeClaimLongTermStorage({ proof, ringIndex, revisionIndex, litePeople: true }),
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

  const result = await tx.signSubmitAndWatch(signer, { customSignedExtensions });
  return new Promise<LtsClaimResult>((resolve, reject) => {
    let lastBlock: number | undefined;
    result.subscribe({
      next: (e: { type: string; ok?: boolean; block?: { number: number } }) => {
        if (e.block) lastBlock = e.block.number;
        if (e.type === "finalized") {
          console.log(
            `[lts-claim] submitted ok=${!!e.ok} block=#${lastBlock ?? "?"}`,
          );
          resolve({ ok: !!e.ok, block: lastBlock, period });
        }
      },
      error: reject,
    });
  });
}
