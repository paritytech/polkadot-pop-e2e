// What the gate is allowed to touch on a fork, and on what evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planUpgrades } from './plan-upgrades.mjs';

const FORK = { relay: 2003001, 'asset-hub': 2000039, people: 1000036, bulletin: 1000026 };
const PLAN = [
  ['relay', 'relay.wasm'],
  ['asset-hub', 'ah.wasm'],
  ['people', 'people.wasm'],
  ['bulletin', 'bulletin.wasm'],
];
const specs = (map) => (wasm) => {
  if (!(wasm in map)) throw new Error(`no spec for ${wasm}`);
  return map[wasm];
};

const plan = (over = {}) =>
  planUpgrades({
    plan: PLAN,
    running: FORK,
    supplied: [],
    specOf: specs({ 'relay.wasm': 2003001, 'ah.wasm': 2000039, 'people.wasm': 1000036, 'bulletin.wasm': 1000026 }),
    ...over,
  });

const chains = (result) => result.keep.map(([chain]) => chain);

describe('what gets upgraded', () => {
  it('leaves every chain alone when the fork already runs those versions', () => {
    const { keep, errors } = plan();
    assert.deepEqual(keep, []);
    assert.deepEqual(errors, []);
  });

  it('upgrades only the chains a caller supplied, whatever else the plan lists', () => {
    const result = plan({
      supplied: ['asset-hub', 'people'],
      specOf: specs({ 'ah.wasm': 2000040, 'people.wasm': 1000037 }),
    });
    assert.deepEqual(chains(result), ['asset-hub', 'people']);
    assert.match(result.notes.join('\n'), /relay .*left as the fork took it from live \(2003001\)/);
  });

  it('upgrades on a higher version when nothing was supplied', () => {
    const result = plan({
      specOf: specs({ 'relay.wasm': 2003001, 'ah.wasm': 2000040, 'people.wasm': 1000036, 'bulletin.wasm': 1000026 }),
    });
    assert.deepEqual(chains(result), ['asset-hub']);
  });

  // Public Paseo runs a relay blob matching no published asset while reporting the
  // pinned spec_version. Deciding on bytes would force-install it on every run.
  it('skips a chain at the same version even though the bytes differ', () => {
    const result = plan();
    assert.match(result.notes.join('\n'), /relay .*skip — already runs 2003001/);
    assert.deepEqual(result.errors, []);
  });
});

describe('what fails', () => {
  it('fails a supplied build that would install nothing', () => {
    const { keep, errors } = plan({ supplied: ['people'] });
    assert.deepEqual(keep, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /people: the supplied build declares spec_version 1000036/);
  });

  it('fails a pin behind what the chain runs', () => {
    const { errors } = plan({
      specOf: specs({ 'relay.wasm': 2003001, 'ah.wasm': 2000038, 'people.wasm': 1000036, 'bulletin.wasm': 1000026 }),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /asset-hub: the pin is spec_version 2000038 but the chain runs 2000039/);
  });

  it('does not treat an unreadable blob as a skip', () => {
    const result = plan({ specOf: () => { throw new Error('no runtime_version section'); } });
    assert.deepEqual(chains(result), ['relay', 'asset-hub', 'people', 'bulletin']);
  });

  it('upgrades a chain the fork manifest does not record', () => {
    const result = planUpgrades({
      plan: [['web3-storage', 'w3s.wasm']],
      running: FORK,
      supplied: [],
      specOf: specs({ 'w3s.wasm': 42 }),
    });
    assert.deepEqual(chains(result), ['web3-storage']);
  });
});
