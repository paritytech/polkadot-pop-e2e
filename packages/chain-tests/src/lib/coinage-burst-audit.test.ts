import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blake2AsHex } from '@polkadot/util-crypto';
import { verifyReceipt } from './coinage-burst-audit.js';
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
