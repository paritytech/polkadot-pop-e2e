import assert from 'node:assert/strict';
import test from 'node:test';
import { sustainPool, type PoolSample, type PoolTransition } from './coinage-sustained.js';

test('refills after inclusion, ends the fixed hold window and drains outstanding watches', async () => {
  let clock = 0, supplied = 0, returned = 0;
  const active = new Map<number, { notify: (s: PoolTransition) => void; resolve: (r: number) => void }>();
  const samples: PoolSample[] = [];
  const finish = (n: number) => {
    for (const [id, entry] of [...active].slice(0, n)) {
      entry.notify('in-block'); active.delete(id); entry.resolve(id);
    }
  };
  const result = await sustainPool({
    target: 10, poolLimit: 12, durationMs: 1000, pollMs: 100, batchSize: 10,
    now: () => clock,
    sleep: async ms => { clock += ms; finish(clock >= 1200 ? active.size : 1); },
    readReady: async () => active.size,
    next: async () => ({ kind: 'work', work: supplied++ }),
    submit: (id, notify) => new Promise<number>(resolve => {
      active.set(id, { notify, resolve }); notify('ready');
      // Let the final outstanding watches settle after the submission window ends.
      if (clock >= 1000) queueMicrotask(() => finish(active.size));
    }),
    recordSample: sample => samples.push(sample), recordResult: () => { returned++; },
  });
  assert.equal(result.holdCompleted, true);
  assert.equal(result.observedHoldMs, 1000);
  assert(result.submitted > 10, 'A single initial burst is not a sustained test');
  assert.equal(returned, result.submitted);
  assert(samples.every(sample => sample.ready <= 10));
});

test('a stale zero gauge cannot trigger repeated fills while submissions are unacknowledged', async () => {
  let clock = 0, submitted = 0;
  const release: Array<() => void> = [];
  const result = await sustainPool({
    target: 10, poolLimit: 12, durationMs: 1000, fillTimeoutMs: 300,
    pollMs: 100, batchSize: 10, now: () => clock,
    sleep: async ms => { clock += ms; if (clock >= 300) release.forEach(fn => fn()); },
    readReady: async () => 0, next: async () => ({ kind: 'work', work: 1 }),
    submit: () => { submitted++; return new Promise<void>(resolve => release.push(resolve)); },
    recordSample: () => {}, recordResult: () => {},
  });
  assert.equal(submitted, 10);
  assert.equal(result.reason, 'fill-timeout');
  assert.equal(result.holdCompleted, false);
});

test('telemetry failure stops new submissions without inventing pool observations', async () => {
  let clock = 0, reads = 0;
  const result = await sustainPool({
    target: 10, poolLimit: 12, durationMs: 1000, now: () => clock,
    sleep: async ms => { clock += ms; },
    readReady: async () => { if (++reads === 2) throw new Error('metrics unavailable'); return 10; },
    next: async () => ({ kind: 'wait' }), submit: async () => {},
    recordSample: () => {}, recordResult: () => {},
  });
  assert.equal(result.submitted, 0);
  assert.equal(result.reason, 'controller-error');
  assert.equal(result.holdCompleted, false);
  assert.match(result.error!, /metrics unavailable/);
  assert(result.unobservedHoldMs > 0);
});

test('returns a prepared dependency when preparation crosses the hold deadline', async () => {
  let clock = 0, released = 0;
  const result = await sustainPool({ target: 10, poolLimit: 12, durationMs: 1000,
    now: () => clock, sleep: async ms => { clock += ms; }, readReady: async () => 9,
    next: async () => { clock += 1100; return { kind: 'work', work: 42 }; },
    release: work => { assert.equal(work, 42); released++; }, submit: async () => {},
    recordSample: () => {}, recordResult: () => {},
  });
  assert.equal(result.submitted, 0);
  assert.equal(released, 1);
  assert.equal(result.holdCompleted, true);
});

test('inclusion does not release unresolved admission budget before finality', async () => {
  let clock = 0, submitted = 0, peakUnresolved = 0;
  const pending: Array<() => void> = [];
  const result = await sustainPool({
    target: 10, poolLimit: 12, maxOutstanding: 96,
    durationMs: 1000, fillTimeoutMs: 500, batchSize: 10, pollMs: 100,
    now: () => clock,
    // Reproduce an optimistic ready gauge while included transactions remain unfinalized.
    readReady: async () => 0,
    sleep: async ms => { clock += ms; if (clock >= 500) pending.splice(0).forEach(resolve => resolve()); },
    next: async () => ({ kind: 'work', work: submitted++ }),
    submit: (_, notify) => new Promise<void>(resolve => {
      pending.push(resolve); peakUnresolved = Math.max(peakUnresolved, pending.length);
      notify('ready'); notify('in-block');
    }),
    recordSample: () => {}, recordResult: () => {},
  });
  assert.equal(result.maxOutstanding, 12);
  assert.equal(result.submitted, 12);
  assert.equal(peakUnresolved, 12);
  assert.equal(result.reason, 'fill-timeout');
});

test('a pool rejection stops admission rather than consuming the remaining inventory', async () => {
  let clock = 0;
  const result = await sustainPool({
    target: 10, poolLimit: 12, batchSize: 1, durationMs: 1000,
    now: () => clock, sleep: async ms => { clock += ms; },
    readReady: async () => 5,
    next: async () => ({ kind: 'work', work: 1 }),
    submit: async (_, notify) => { notify('rejected'); notify('terminal'); return 'rejected'; },
    recordSample: () => {}, recordResult: () => {},
  });
  assert.equal(result.submitted, 1);
  assert.equal(result.reason, 'admission-rejected');
  assert.equal(result.holdCompleted, false);
});
