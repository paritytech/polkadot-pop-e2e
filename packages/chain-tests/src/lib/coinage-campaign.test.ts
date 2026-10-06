import assert from 'node:assert/strict';
import { test } from 'node:test';
import { campaign, groups, recyclingDecision } from './coinage-campaign.js';
import { tokenContext } from './coinage-unload.js';
test('all 24 cases exist and paced release partitions actors without overlap', () => {
  assert.equal(campaign.length, 24);
  assert.equal(new Set(campaign.map(c => c.id)).size, 24);
  const waves = groups(10000, 'paced'); assert.deepEqual(waves.map(w => w.length), [8000, 2000]);
  assert.equal(new Set(waves.flat()).size, 10000); assert.equal(waves[1][0], 8000);
  assert.throws(() => groups(1000, 'paced'));
});
test('reserve boundary defers discretionary recycling but preserves forced loads', () => {
  for (const platform of ['android', 'ios'] as const) {
    const base = { platform, limit: 100, maximumAge: 16, discretionary: true };
    assert.equal(recyclingDecision({ ...base, age: 1, remaining: 21 }).action, 'discretionary-load');
    for (const remaining of [20, 0]) {
      assert.equal(recyclingDecision({ ...base, age: 1, remaining }).action, 'retain');
      assert.equal(recyclingDecision({ ...base, age: 14, remaining }).action, 'forced-load');
    }
    assert.equal(recyclingDecision({ ...base, age: 14, remaining: 0, readFailed: true }).action,
      platform === 'ios' ? 'abort' : 'forced-load');
  }
});
test('free token contexts match the runtime layout and reject invalid counters', () => {
  const context = tokenContext(123, 456); assert.equal(context.length, 32);
  assert.equal(new DataView(context.buffer).getUint32(24, true), 123);
  assert.equal(new DataView(context.buffer).getUint32(28, true), 456);
  assert.throws(() => tokenContext(0, -1));
});
