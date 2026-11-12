import type { Transaction, TxFinalizedPayload } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

/** Signs and submits `tx`, resolving once it is finalized; fails when its dispatch fails. */
export async function submitFinalized(
  tx: Pick<Transaction<any>, "createAndSubmit">,
  signer: CommonSignerTxCreator,
): Promise<TxFinalizedPayload> {
  const result = await tx.createAndSubmit(signer);
  if (!result.ok) {
    const error = JSON.stringify(result.dispatchError, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    throw new Error(`dispatch failed in block #${result.block.number}: ${error}`);
  }
  return result;
}
