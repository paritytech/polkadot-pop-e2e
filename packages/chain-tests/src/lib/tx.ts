import type { PolkadotSigner, TxEvent } from "polkadot-api";

/**
 * Submit a transaction and resolve as soon as it's included in a best block
 * (not waiting for finalization). Much faster for health checks.
 */
export function submitAndWatchBestBlock(
  tx: { signSubmitAndWatch: (signer: PolkadotSigner) => import("rxjs").Observable<TxEvent> },
  signer: PolkadotSigner,
): Promise<{ ok: boolean; block?: { hash: string; number: number } }> {
  return new Promise((resolve, reject) => {
    const subscription = tx.signSubmitAndWatch(signer).subscribe({
      next(event: TxEvent) {
        if (event.type === "txBestBlocksState") {
          if (event.found) {
            subscription.unsubscribe();
            resolve({
              ok: true,
              block: { hash: event.block.hash, number: event.block.number },
            });
          }
          // found=false means it was dropped from best block — keep waiting
        }
        if (event.type === "finalized") {
          subscription.unsubscribe();
          resolve({ ok: event.ok });
        }
      },
      error(err: unknown) {
        subscription.unsubscribe();
        reject(err);
      },
    });
  });
}
