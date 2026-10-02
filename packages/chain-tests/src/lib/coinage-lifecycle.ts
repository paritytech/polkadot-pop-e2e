import assert from 'node:assert/strict';

export type Coin = { instance_id: number; value: number; age: number };
export function checkSplitState(instance: number, claimed: boolean, state: {
  source?: Coin; payment?: Coin; change?: Coin; recipient?: Coin;
}) {
  assert.equal(state.source, undefined, 'Source coin was not consumed');
  assert.deepEqual(state.change, { instance_id: instance, value: 1, age: 1 }, 'Change differs');
  assert.deepEqual(state.payment, claimed ? undefined : { instance_id: instance, value: 1, age: 1 }, 'Payment output differs');
  assert.deepEqual(state.recipient, claimed ? { instance_id: instance, value: 1, age: 2 } : undefined, 'Recipient differs');
  // The fixed plan is 4 = 2 payment + 2 change. Wrong denominations cannot pass.
}

/** All pages must come from the same finalized block. Presence alone is not readiness. */
export function readyMembers(
  pages: Array<{ keyArgs: [string, number, number]; value: string[] }>,
  statuses: Array<{ keyArgs: [string, number]; value: { included: number } }>,
  roots: Array<{ keyArgs: [string, number]; value: { revision: number } }>,
  expected: Set<string>,
) {
  const found = new Map<string, { ring: number; position: number; included: number; revision: number }>();
  const offsets = new Map<number, number>();
  const nextPages = new Map<number, number>();
  for (const page of [...pages].sort((a, b) => a.keyArgs[1] - b.keyArgs[1] || a.keyArgs[2] - b.keyArgs[2])) {
    const [collection, ring, index] = page.keyArgs;
    assert.equal(index, nextPages.get(ring) ?? 0, 'Missing member page: cannot infer positions');
    nextPages.set(ring, index + 1);
    const offset = offsets.get(ring) ?? 0;
    const status = statuses.find(s => s.keyArgs[0] === collection && s.keyArgs[1] === ring)?.value;
    const root = roots.find(r => r.keyArgs[0] === collection && r.keyArgs[1] === ring)?.value;
    page.value.forEach((member, i) => {
      if (root && status && offset + i < status.included && expected.has(member)) {
        assert(!found.has(member), 'Duplicate member in rings');
        found.set(member, { ring, position: offset + i, included: status.included, revision: root.revision });
      }
    });
    offsets.set(ring, offset + page.value.length);
  }
  return found;
}
