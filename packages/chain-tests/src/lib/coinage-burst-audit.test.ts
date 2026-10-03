import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blake2AsHex } from '@polkadot/util-crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditBurst, verifyReceipt } from './coinage-burst-audit.js';
const extrinsic = '0x01020304';
const hash = blake2AsHex(extrinsic);
const event = (type: string, name: string, index = 0) => ({ phase: { type: 'ApplyExtrinsic', value: index },
  event: { type, value: { type: name } } });
const events = [event('System', 'ExtrinsicSuccess'), event('Coinage', 'CoinTransferred')];
test('block receipt requires matching bytes, indexed success and the expected Coinage event', () => {
  assert.equal(verifyReceipt(hash, 0, [extrinsic], events, 'CoinTransferred').length, 2);
  assert.throws(() => verifyReceipt(hash, 0, ['0x0506'], events, 'CoinTransferred'), /hash/);
  assert.throws(() => verifyReceipt(hash, 1, [extrinsic], events, 'CoinTransferred'), /index/);
  assert.throws(() => verifyReceipt(hash, 0, [extrinsic], [event('System', 'ExtrinsicSuccess', 1)], 'CoinTransferred'), /success/);
  assert.throws(() => verifyReceipt(hash, 0, [extrinsic], [event('System', 'ExtrinsicSuccess')], 'CoinTransferred'), /Coinage/);
  assert.throws(() => verifyReceipt(hash, 0, [extrinsic], [...events, event('System', 'ExtrinsicFailed')], 'CoinTransferred'), /failed/);
});

test('deferred timing verdict preserves failed audit and still rejects invalid receipts', async () => {
  const out = mkdtempSync(join(tmpdir(), 'coinage-audit-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    const result = method === 'chain_getBlock' ? { block: { header: { number: '0x1' }, extrinsics: [extrinsic] } }
      : method === 'chain_getHeader' ? { number: '0x2' } : '0xab';
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  const input = {
    name: 'timing', expected: 1, out, operation: 'CoinTransferred',
    results: [{ status: 'finalized', txHash: hash, block: { hash: '0xab', number: 1, index: 0 }, elapsedMs: 10 }],
    api: { query: { System: { Events: { getValue: async () => events } } } },
    summary: { passed: false, generatorLimited: true }, requireScenarioPass: false,
  } as unknown as Parameters<typeof auditBurst>[0];
  try {
    const audit = await auditBurst(input);
    assert.equal(audit.verifiedReceipts, 1);
    assert.equal(audit.passed, false);
    assert.equal(JSON.parse(readFileSync(`${out}/timing-audit.json`, 'utf8')).passed, false);
    await assert.rejects(auditBurst({ ...input, requireScenarioPass: true }), /scenario checks/);
    await assert.rejects(auditBurst({ ...input, results: [] }), /receipt evidence/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(out, { recursive: true, force: true });
  }
});
