/**
 * Submission shared by the People chain's `AsResources` claims: the unsigned
 * general transaction, with every other v1 extension left at its no-op value.
 */
import type { Transaction, TxEvent } from "polkadot-api";
import type { TxCreator } from "polkadot-api/tx-creator";
import type { CommonEnhancersSpecs } from "@polkadot-api/signers-common";

/** No-op values for People's v1 extensions; the claim signer fills `AsResources`. */
export const PEOPLE_CLAIM_EXTENSIONS = {
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

/**
 * Invalid-transaction errors a fresh ring snapshot can cure: `BadProof` when
 * the revision left the grace window, `Future`/`Stale` on replay checks.
 */
export function isRetryableInvalidTx(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /BadProof|Future|Stale/i.test(msg);
}

export interface FinalizedClaim {
  ok: boolean;
  block?: number;
  blockHash?: string;
}

/** Submits a People claim and resolves once it is finalized. */
export async function submitPeopleClaim(
  tx: Pick<Transaction<any>, "createSubmitAndWatch">,
  signer: TxCreator<CommonEnhancersSpecs>,
): Promise<FinalizedClaim> {
  return submitUntilFinalized(tx, signer, PEOPLE_CLAIM_EXTENSIONS);
}

/** Submits `tx` with `customSignedExtensions` and resolves once it is finalized. */
async function submitUntilFinalized(
  tx: Pick<Transaction<any>, "createSubmitAndWatch">,
  signer: TxCreator<CommonEnhancersSpecs>,
  customSignedExtensions: Record<string, { value: unknown }>,
): Promise<FinalizedClaim> {
  const events = tx.createSubmitAndWatch(signer, { customSignedExtensions });
  return new Promise((resolve, reject) => {
    let last: { number: number; hash: string } | undefined;
    events.subscribe({
      next: (e: TxEvent) => {
        if ("block" in e && e.block) last = e.block;
        if (e.type === "finalized") resolve({ ok: !!e.ok, block: last?.number, blockHash: last?.hash });
      },
      error: reject,
    });
  });
}
