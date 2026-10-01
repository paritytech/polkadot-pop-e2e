import type { WsProvider } from '@polkadot/api';
import { blake2AsHex } from '@polkadot/util-crypto';
import type { SubmissionResult } from './coinage-client.js';

type Event = { phase: { type: string; value?: unknown }; event: {
  type: string; value: { type: string; value?: unknown };
} };
type Block = { number: number; extrinsics: string[]; events: Event[] };
export type BurstResult = SubmissionResult & {
  /** Bounded sample; full non-broadcast transitions can be streamed by the caller. */
  rpcObservations: Array<{ elapsedMs: number; status: unknown }>;
  watchSummary: { notifications: number; broadcasts: number; omittedObservations: number;
    firstBroadcastMs?: number; lastBroadcastMs?: number; readyMs?: number };

};

/** connect() only starts the handshake; wait for readiness before measuring a burst. */
export async function connectBurstProvider(
  provider: Pick<WsProvider, 'connect' | 'isReady' | 'disconnect'>, timeoutMs = 15_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await provider.connect();
    await Promise.race([
      provider.isReady,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Burst RPC connection readiness timed out')), timeoutMs);
      }),
    ]);
  } catch (error) { await provider.disconnect(); throw error; }
  finally { clearTimeout(timer); }
}

/** Shared RPC connection with a bounded finalized-block cache. Evicted blocks can be read again. */
export function burstSubmitter(
  provider: Pick<WsProvider, 'subscribe' | 'unsubscribe'>,
  readBlock: (hash: string) => Promise<Block>,
  recordObservation?: (txHash: string, observation: { elapsedMs: number; status: unknown }) => void,
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
      // Cache recent blocks only, including in-flight reads. Late watches re-read an evicted block.
      if (blocks.size > 16) blocks.delete(blocks.keys().next().value!);
      void pending.catch(() => { if (blocks.get(hash) === pending) blocks.delete(hash); });
    }
    return pending;
  };
  return (prepared: { hex: string; txHash: string }, timeoutMs: number): Promise<BurstResult> => new Promise(resolve => {
    const started = performance.now();
    const rpcObservations: BurstResult['rpcObservations'] = [];
    const watchSummary: BurstResult['watchSummary'] = { notifications: 0, broadcasts: 0, omittedObservations: 0 };
    let finalizing = false;
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
        observations: [], rpcObservations, watchSummary, ...result });
    };
    const timer = setTimeout(() => finish({ status: 'unresolved' }), timeoutMs);
    // No automatic retry. A dropped/unresolved watch does not prove the transaction never landed.
    try { void provider.subscribe('author_extrinsicUpdate', 'author_submitAndWatchExtrinsic', [prepared.hex], (error, status: unknown) => {
      if (settled) return;
      if (error) { finish({ status: 'submission-error', error: String(error) }); return; }
      const elapsedMs = performance.now() - started;
      watchSummary.notifications++;
      if (typeof status === 'object' && status && 'broadcast' in status) {
        // Peer lists repeated for every pending transaction dominated the million-claim heap.
        watchSummary.broadcasts++;
        watchSummary.firstBroadcastMs ??= elapsedMs;
        watchSummary.lastBroadcastMs = elapsedMs;
        return;
      }
      if (status === 'ready') watchSummary.readyMs ??= elapsedMs;
      const observation = { elapsedMs, status };
      try { recordObservation?.(prepared.txHash, observation); }
      catch (error) { finish({ status: 'unresolved', error: `Watch evidence write failed: ${String(error)}` }); return; }
      if (rpcObservations.length < 16) rpcObservations.push(observation);
      else watchSummary.omittedObservations++;

      if (status === 'invalid' || status === 'dropped' || (typeof status === 'object' && status && 'usurped' in status)) {
        finish({ status: 'submission-error', error: status });
      } else if (typeof status === 'object' && status && 'finalized' in status && typeof status.finalized === 'string') {
        if (finalizing) return;
        finalizing = true;
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
