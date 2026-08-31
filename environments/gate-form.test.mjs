// The gate's two request channels: field-per-override in, sparse target overlay out.
// Both channels share FIELDS, so these cases pin the shape they must agree on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, parseIssueForm, parseDispatchInputs, splitPpnRef } from './gate-form.mjs';
import { mergeTarget, validateManifest } from './release-map.mjs';
import fs from 'node:fs';
import path from 'node:path';

const body = (fields) =>
  Object.entries(fields)
    .map(([label, value]) => `### ${label}\n\n${value}\n`)
    .join('\n');

const dispatch = (values) =>
  Object.fromEntries(Object.entries(values).map(([id, v]) => [`GATE_${id.toUpperCase()}`, v]));

describe('issue-form parsing', () => {
  it('assembles the overlay from individual fields, skipping empty ones', () => {
    const { network, target } = parseIssueForm(
      body({
        Network: 'previewnet',
        'Node binary: polkadot': 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        'Node binary: polkadot-omni-node': '_No response_',
        'Runtime: bulletin': 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo',
        'Service: eth-rpc': '_No response_',
      })
    );
    assert.equal(network, 'previewnet');
    assert.deepEqual(target, {
      binaries: { polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
      chains: { bulletin: { runtime: 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo' } },
    });
  });

  it('an all-empty form is a steady-state run (null target)', () => {
    const { target } = parseIssueForm(body({ Network: 'previewnet' }));
    assert.equal(target, null);
  });

  it('the raw JSON textarea replaces the fields entirely', () => {
    const { target } = parseIssueForm(
      body({
        Network: 'devnet',
        'Runtime: relay': 'paseo-network/runtimes@v2.4.9',
        'Advanced: raw target overlay (JSON)':
          '```json\n{"chains":{"relay":{"runtime":"paseo-network/runtimes@v2.4.5"}}}\n```',
      })
    );
    assert.deepEqual(target, { chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } } });
  });

  it('rejects a body with no network', () => {
    assert.throws(() => parseIssueForm('### Something else\n\nvalue\n'), /names no network/);
  });
});

describe('dispatch-form parsing', () => {
  it('reads one GATE_<ID> env var per field', () => {
    const { target } = parseDispatchInputs(
      dispatch({
        binary_polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        binary_polkadot_omni_node: '',
        runtime_bulletin: 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo',
      })
    );
    assert.deepEqual(target, {
      binaries: { polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
      chains: { bulletin: { runtime: 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo' } },
    });
  });

  it('an all-empty dispatch is a steady-state run (null target)', () => {
    assert.equal(parseDispatchInputs({}).target, null);
  });

  it('GATE_ADVANCED replaces the fields entirely', () => {
    const { target } = parseDispatchInputs({
      ...dispatch({ runtime_relay: 'paseo-network/runtimes@v2.4.9' }),
      GATE_ADVANCED: '{"tests":["test:ring-health"]}',
    });
    assert.deepEqual(target, { tests: ['test:ring-health'] });
  });

  it('agrees with the issue channel field-for-field', () => {
    const values = Object.fromEntries(FIELDS.map(({ id }) => [id, `owner/repo@${id}`]));
    const labelled = Object.fromEntries(FIELDS.map(({ id, label }) => [label, `owner/repo@${id}`]));
    assert.deepEqual(
      parseDispatchInputs(dispatch(values)).target,
      parseIssueForm(body({ Network: 'previewnet', ...labelled })).target
    );
  });
});

describe('per-chain runtime fields', () => {
  it('pins asset-hub and people independently', () => {
    const { target } = parseDispatchInputs(
      dispatch({
        runtime_asset_hub: 'paritytech/individuality@v0.12.0',
        runtime_people: 'paritytech/individuality-community@nightly-2026-08-28',
      })
    );
    assert.deepEqual(target, {
      chains: {
        'asset-hub': { runtime: 'paritytech/individuality@v0.12.0' },
        people: { runtime: 'paritytech/individuality-community@nightly-2026-08-28' },
      },
    });
  });

  // The point of the artifact: form — a build from the calling run reads the same
  // as a release, so the call says which chains are under test either way.
  it('takes a build from the calling run for one chain and a release for another', () => {
    const { target } = parseDispatchInputs(
      dispatch({
        runtime_asset_hub: 'artifact:e2e-runtime-wasm',
        runtime_relay: 'paseo-network/runtimes@v2.4.5',
      })
    );
    assert.deepEqual(target, {
      chains: {
        'asset-hub': { runtime: 'artifact:e2e-runtime-wasm' },
        relay: { runtime: 'paseo-network/runtimes@v2.4.5' },
      },
    });
  });

  it('stays splittable through the advanced overlay', () => {
    const { target } = parseDispatchInputs({
      GATE_ADVANCED: '{"chains":{"people":{"runtime":"paritytech/individuality@v0.12.0"}}}',
    });
    assert.deepEqual(target, {
      chains: { people: { runtime: 'paritytech/individuality@v0.12.0' } },
    });
  });
});

describe('ppn_ref', () => {
  it('is lifted out of the overlay, leaving the pins behind', () => {
    const { ppnRef, target } = splitPpnRef({
      ppn_ref: 'mak/engine-branch',
      chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } },
    });
    assert.equal(ppnRef, 'mak/engine-branch');
    assert.deepEqual(target, { chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } } });
  });

  it('alone in the overlay leaves a steady-state run', () => {
    const { ppnRef, target } = splitPpnRef({ ppn_ref: 'mak/engine-branch' });
    assert.equal(ppnRef, 'mak/engine-branch');
    assert.equal(target, null);
  });

  it('is empty when the overlay does not name one', () => {
    assert.equal(splitPpnRef({ tests: ['test:network-health'] }).ppnRef, '');
    assert.equal(splitPpnRef(null).ppnRef, '');
  });
});

describe('assembled overlays validate against the canonical manifests', () => {
  const manifest = (net) =>
    JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'networks', `${net}.json`), 'utf8'));

  it('merges a full previewnet ask', () => {
    const { target } = parseDispatchInputs(
      dispatch({
        binary_polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        binary_polkadot_omni_node: 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        runtime_individuality: 'paritytech/individuality@v0.12.0-previewnet',
        runtime_bulletin: 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo',
      })
    );
    validateManifest(mergeTarget(manifest('previewnet'), target));
  });

  it('rejects a chain the network does not run', () => {
    const { target } = parseDispatchInputs(
      dispatch({ runtime_web3_storage: 'paritytech/web3-storage@v0.4.2-paseo' })
    );
    assert.throws(() => mergeTarget(manifest('devnet'), target), /web3-storage/);
  });
});
