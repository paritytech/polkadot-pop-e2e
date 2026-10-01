import assert from 'node:assert/strict';
import test from 'node:test';
import { blake2AsHex } from '@polkadot/util-crypto';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WsProvider } from '@polkadot/api';
import { burstSubmitter, connectBurstProvider } from './coinage-burst-submit.js';

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

test('waits for an actual WebSocket handshake before allowing submissions', async () => {
  const server = createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  let upgraded = false;
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    setTimeout(() => {
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      upgraded = true;
    }, 30);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const provider = new WsProvider(`ws://127.0.0.1:${address.port}`, false);
  try {
    const connecting = connectBurstProvider(provider, 1000);
    assert.equal(provider.isConnected, false);
    await connecting;
    assert.equal(upgraded, true);
    assert.equal(provider.isConnected, true);
  } finally {
    await provider.disconnect();
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('cleans up when connection readiness times out', async () => {
  let disconnected = false;
  await assert.rejects(connectBurstProvider({
    connect: async () => {}, isReady: new Promise<WsProvider>(() => {}),
    disconnect: async () => { disconnected = true; },
  }, 5), /readiness timed out/);
  assert.equal(disconnected, true);
});

test('aggregates a million broadcasts and streams transitions without retaining an unbounded trace', async () => {
  const f = fixture();
  let streamed = 0;
  const submit = burstSubmitter(f.provider, async () => {
    throw new Error('must not read');
  }, (_hash, observation) => {
    assert(!('broadcast' in Object(observation.status)));
    streamed++;
  });
  const result = submit({ hex: '0x12', txHash: 'hash' }, 10000);
  for (let i = 0; i < 1_000_000; i++) f.callbacks[0](null, { broadcast: [`peer-${i}`] });
  for (let i = 0; i < 100; i++) {
    f.callbacks[0](null, { inBlock: `block-${i}` });
    f.callbacks[0](null, { retracted: `block-${i}` });
  }
  // Ready must survive even when the bounded sample is already full.
  f.callbacks[0](null, 'ready');
  f.callbacks[0](null, 'dropped');
  const r = await result;
  assert.equal(r.status, 'submission-error');
  assert.equal(r.watchSummary.broadcasts, 1_000_000);
  assert.equal(r.watchSummary.notifications, 1_000_202);
  assert.equal(r.watchSummary.omittedObservations, 186);
  assert.equal(r.rpcObservations.length, 16);
  assert.equal(streamed, 202);
  assert.equal(typeof r.watchSummary.readyMs, 'number');
  assert(r.watchSummary.lastBroadcastMs! >= r.watchSummary.firstBroadcastMs!);
});

test('evicts old blocks but re-verifies a late watch instead of losing its receipt', async () => {
  const f = fixture();
  const reads: string[] = [];
  const submit = burstSubmitter(f.provider, async hash => {
    reads.push(hash);
    return { number: 1, extrinsics: ['0x12'], events: [success(0)] };
  });
  for (let i = 0; i < 18; i++) {
    const result = submit({ hex: '0x12', txHash: blake2AsHex('0x12') }, 1000);
    f.callbacks.at(-1)!(null, { finalized: `block-${i}` });
    assert.equal((await result).status, 'finalized');
  }
  const late = submit({ hex: '0x12', txHash: blake2AsHex('0x12') }, 1000);
  f.callbacks.at(-1)!(null, { finalized: 'block-0' });
  assert.equal((await late).status, 'finalized');
  assert.equal(reads.filter(hash => hash === 'block-0').length, 2);
});

test('does not report success when streaming evidence fails', async () => {
  const f = fixture();
  const submit = burstSubmitter(f.provider, async () => {
    throw new Error('must not read');
  }, () => { throw new Error('disk full'); });
  const result = submit({ hex: '0x12', txHash: 'hash' }, 1000);
  f.callbacks[0](null, 'ready');
  assert.equal((await result).status, 'unresolved');
  assert.match(String((await result).error), /disk full/);
});
