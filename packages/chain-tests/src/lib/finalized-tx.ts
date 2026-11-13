import type { Transaction, TxFinalizedPayload } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { formatDispatchError } from "@parity/product-sdk-tx";

/** Signs and submits `tx`, resolving once it is finalized; fails when its dispatch fails. */
export async function submitFinalized(
  tx: Pick<Transaction<any>, "createAndSubmit">,
  signer: CommonSignerTxCreator,
): Promise<TxFinalizedPayload> {
  const result = await tx.createAndSubmit(signer);
  if (!result.ok) throw new Error(`dispatch failed in block #${result.block.number}: ${formatDispatchError(result)}`);
  return result;
}
