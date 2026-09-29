import assert from 'node:assert/strict';
import test from 'node:test';
import { blake2AsHex } from '@polkadot/util-crypto';
import { burstSubmitter } from './coinage-burst-submit.js';

function fixture() {
  const callbacks: Array<(error: Error | null, status: unknown) => void> = [];
  const cancelled: Array<string | number> = [];
  const provider = {
    async subscribe(_type: string, _method: string, _params: unknown[], callback: typeof callbacks[number]) {
      callbacks.push(callback); return callbacks.length;
    },
    async unsubscribe(_type: string, _method: string, id: string | number) { cancelled.push(id); return true; },
  };
  return { callbacks, cancelled, provider };
}
const success = (index: number) => ({ phase: { type: 'ApplyExtrinsic', value: index },
  event: { type: 'System', value: { type: 'ExtrinsicSuccess' } } });

test('shares block decoding, finds actual indexes, and does not equate ready with finality', async () => {
  const f = fixture(); let reads = 0; let completed = 0;
  const submit = burstSubmitter(f.provider, async () => {
    reads++; return { number: 42, extrinsics: ['0x00', '0x12', '0x34'], events: [success(1), success(2)] };
  });
  const a = submit({ hex: '0x12', txHash: blake2AsHex('0x12') }, 1000).then(r => { completed++; return r; });
  const b = submit({ hex: '0x34', txHash: blake2AsHex('0x34') }, 1000);
  f.callbacks[0](null, 'ready');
  await Promise.resolve(); assert.equal(completed, 0);
  f.callbacks.forEach(cb => cb(null, { finalized: '0xabc' }));
  const results = await Promise.all([a, b]);
  assert.equal(reads, 1);
  assert.deepEqual(results.map(r => [r.status, r.block?.index]), [['finalized', 1], ['finalized', 2]]);
  assert.equal(results[0].rpcObservations[0].status, 'ready');
  assert.deepEqual(f.cancelled.sort(), [1, 2]);
});

test('does not turn dispatch failure or a missing transaction into success', async () => {
  const f = fixture();
  const submit = burstSubmitter(f.provider, async () => ({ number: 1, extrinsics: ['0x12'], events: [{
    phase: { type: 'ApplyExtrinsic', value: 0 }, event: { type: 'System', value: { type: 'ExtrinsicFailed' } },
  }] }));
  const a = submit({ hex: '0x12', txHash: blake2AsHex('0x12') }, 1000);
  const b = submit({ hex: '0x34', txHash: blake2AsHex('0x34') }, 1000);
  f.callbacks.forEach(cb => cb(null, { finalized: '0xabc' }));
  assert.deepEqual((await Promise.all([a, b])).map(r => r.status), ['dispatch-error', 'unresolved']);
});

test('records rejected and timed-out watches without retrying', async () => {
  const f = fixture();
  const submit = burstSubmitter(f.provider, async () => { throw new Error('must not read'); });
  const a = submit({ hex: '0x12', txHash: 'hash' }, 1000);
  f.callbacks[0](null, 'dropped');
  assert.equal((await a).status, 'submission-error');
  const b = await submit({ hex: '0x12', txHash: 'hash2' }, 5);
  assert.equal(b.status, 'unresolved');
  assert.equal(f.callbacks.length, 2);
});

test('records a synchronous provider failure instead of rejecting the burst', async () => {
  const f = fixture();
  f.provider.subscribe = () => { throw new Error('disconnected'); };
  const submit = burstSubmitter(f.provider, async () => { throw new Error('must not read'); });
  const result = await submit({ hex: '0x12', txHash: 'hash' }, 1000);
  assert.equal(result.status, 'submission-error');
  assert.match(String(result.error), /disconnected/);
});
