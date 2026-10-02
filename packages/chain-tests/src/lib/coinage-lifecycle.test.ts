import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSplitState, readyMembers } from './coinage-lifecycle.js';

test('split and claim require conservation, correct age, change and source consumption', () => {
  const coin = { instance_id: 7, value: 1, age: 1 };
  checkSplitState(7, false, { payment: coin, change: coin });
  checkSplitState(7, true, { change: coin, recipient: { ...coin, age: 2 } });
  assert.throws(() => checkSplitState(7, false, { payment: coin, change: { ...coin, value: 2 } }));
  assert.throws(() => checkSplitState(7, true, { payment: coin, change: coin, recipient: { ...coin, age: 2 } }));
  assert.throws(() => checkSplitState(7, true, { change: coin, recipient: coin }));
  assert.throws(() => checkSplitState(7, false, { source: coin, payment: coin, change: coin }));
});

test('readiness requires an included position AND a root; page offsets and rings are independent', () => {
  const pages = [
    { keyArgs: ['c', 0, 1] as [string, number, number], value: ['b', 'c'] },
    { keyArgs: ['c', 1, 0] as [string, number, number], value: ['d'] },
    { keyArgs: ['c', 0, 0] as [string, number, number], value: ['a'] },
  ];
  const statuses = [{ keyArgs: ['c', 0] as [string, number], value: { included: 2 } },
    { keyArgs: ['c', 1] as [string, number], value: { included: 1 } }];
  const roots = [{ keyArgs: ['c', 0] as [string, number], value: { revision: 3 } }];
  const expected = new Set(['a', 'b', 'c', 'd']);
  const ready = readyMembers(pages, statuses, roots, expected);
  assert.deepEqual([...ready.keys()], ['a', 'b']);
  assert.equal(ready.get('b')?.position, 1);
  assert.equal(ready.get('b')?.revision, 3);
  assert.equal(readyMembers(pages, statuses, [], expected).size, 0);
  assert.throws(() => readyMembers(pages.slice(0, 2), statuses, roots, expected), /Missing member page/);
});
