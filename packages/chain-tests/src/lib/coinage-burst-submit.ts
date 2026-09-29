import type { WsProvider } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import type { SubmissionResult } from './coinage-client.js';

type Event = { phase: { type: string; value?: unknown }; event: {
  type: string; value: { type: string; value?: unknown };
} };
type Block = { number: number; extrinsics: string[]; events: Event[] };
export type BurstResult = SubmissionResult & {
  rpcObservations: Array<{ elapsedMs: number; status: unknown }>;
};

/** One RPC connection and one block read per finalized block, not a full client per transaction group. */
export function burstSubmitter(
  provider: Pick<WsProvider, 'subscribe' | 'unsubscribe'>,
  readBlock: (hash: string) => Promise<Block>,
) {
  const blocks = new Map<string, Promise<Map<string, { index: number; number: number; events: Event[] }>>>();
  const blockReceipts = (hash: string) => {
    let pending = blocks.get(hash);
    if (!pending) {
      pending = readBlock(hash).then(block => {
        const events = new Map<number, Event[]>();
        for (const event of block.events) {
          if (event.phase.type !== 'ApplyExtrinsic' || typeof event.phase.value !== 'number') continue;
          const own = events.get(event.phase.value) ?? [];
          own.push(event);
          events.set(event.phase.value, own);
        }
        return new Map(block.extrinsics.map((bytes, index) => [blake2AsHex(bytes), {
          index, number: block.number, events: events.get(index) ?? [],
        }]));
      });
      blocks.set(hash, pending);
    }
    return pending;
  };
  return (prepared: { hex: string; txHash: string }, timeoutMs: number): Promise<BurstResult> => new Promise(resolve => {
    const started = performance.now();
    const rpcObservations: BurstResult['rpcObservations'] = [];
    let id: number | string | undefined;
    let settled = false;
    const unsubscribe = () => {
      if (id !== undefined) void provider.unsubscribe('author_extrinsicUpdate', 'author_unwatchExtrinsic', id).catch(() => {});
    };
    const finish = (result: Pick<SubmissionResult, 'status' | 'block' | 'error'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ txHash: prepared.txHash, elapsedMs: performance.now() - started,
        observations: [], rpcObservations, ...result });
    };
    const timer = setTimeout(() => finish({ status: 'unresolved' }), timeoutMs);
    // No automatic retry. A dropped/unresolved watch does not prove the transaction never landed.
    try { void provider.subscribe('author_extrinsicUpdate', 'author_submitAndWatchExtrinsic', [prepared.hex], (error, status: unknown) => {
      if (settled) return;
      if (error) { finish({ status: 'submission-error', error: String(error) }); return; }
      rpcObservations.push({ elapsedMs: performance.now() - started, status });
      if (status === 'invalid' || status === 'dropped' || (typeof status === 'object' && status && 'usurped' in status)) {
        finish({ status: 'submission-error', error: status });
      } else if (typeof status === 'object' && status && 'finalized' in status && typeof status.finalized === 'string') {
        const hash = status.finalized;
        void blockReceipts(hash).then(receipts => {
          const receipt = receipts.get(prepared.txHash);
          if (!receipt) throw new Error('Finalized notification has no matching block extrinsic');
          const failed = receipt.events.find(e => e.event.type === 'System' && e.event.value.type === 'ExtrinsicFailed');
          const success = receipt.events.some(e => e.event.type === 'System' && e.event.value.type === 'ExtrinsicSuccess');
          if (!failed && !success) throw new Error('Finalized transaction has no dispatch outcome');
          finish({ status: failed ? 'dispatch-error' : 'finalized',
            block: { hash, number: receipt.number, index: receipt.index }, error: failed?.event.value.value });
        }).catch(error => finish({ status: 'unresolved', error: String(error) }));
      }
    }).then(value => { id = value; if (settled) unsubscribe(); })
      .catch(error => finish({ status: 'submission-error', error: String(error) }));
    } catch (error) { finish({ status: 'submission-error', error: String(error) }); }
  });
}
