// The gate's two request channels: field-per-override in, sparse target overlay out.
// Both channels share FIELDS, so these cases pin the shape they must agree on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, parseIssueForm, parseDispatchInputs, splitRunOptions } from './gate-form.mjs';
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
        runtime_asset_hub: 'paritytech/individuality-community@v0.3.1',
        runtime_people: 'paritytech/individuality-community@nightly-2026-08-28',
      })
    );
    assert.deepEqual(target, {
      chains: {
        'asset-hub': { runtime: 'paritytech/individuality-community@v0.3.1' },
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
      GATE_ADVANCED: '{"chains":{"people":{"runtime":"paritytech/individuality-community@v0.3.1"}}}',
    });
    assert.deepEqual(target, {
      chains: { people: { runtime: 'paritytech/individuality-community@v0.3.1' } },
    });
  });
});

describe('run options', () => {
  it('ppn_ref is lifted out of the overlay, leaving the pins behind', () => {
    const { ppnRef, target } = splitRunOptions({
      ppn_ref: 'mak/engine-branch',
      chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } },
    });
    assert.equal(ppnRef, 'mak/engine-branch');
    assert.deepEqual(target, { chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } } });
  });

  it('alone in the overlay leave a steady-state run', () => {
    const { ppnRef, target } = splitRunOptions({ ppn_ref: 'mak/engine-branch' });
    assert.equal(ppnRef, 'mak/engine-branch');
    assert.equal(target, null);
  });

  it('are empty when the overlay does not contain them', () => {
    assert.deepEqual(splitRunOptions({ tests: ['test:network-health'] }), {
      ppnRef: '',
      productSdk: '',
      truapi: '',
      target: { tests: ['test:network-health'] },
    });
    assert.equal(splitRunOptions(null).ppnRef, '');
  });

  // A runtime PR testing its change against an unreleased fix: the client builds
  // ride next to the runtime pins and stay out of the manifest.
  it('carry the client builds next to the runtime pins', () => {
    const { productSdk, truapi, target } = splitRunOptions(
      parseDispatchInputs(
        dispatch({
          runtime_people: 'artifact:e2e-runtime-wasm',
          product_sdk: '@parity/product-sdk-individuality@0.10.1-dev.453.0',
          truapi: '0.29.0-rc.1',
        })
      ).target
    );
    assert.equal(productSdk, '@parity/product-sdk-individuality@0.10.1-dev.453.0');
    assert.equal(truapi, '0.29.0-rc.1');
    assert.deepEqual(target, { chains: { people: { runtime: 'artifact:e2e-runtime-wasm' } } });
  });

  it('remain when the advanced overlay replaces the pin fields', () => {
    const { productSdk, target } = splitRunOptions(
      parseDispatchInputs({
        ...dispatch({ runtime_relay: 'paseo-network/runtimes@v2.4.9', product_sdk: '@parity/product-sdk@dev' }),
        GATE_ADVANCED: '{"tests":["test:ring-health"]}',
      }).target
    );
    assert.equal(productSdk, '@parity/product-sdk@dev');
    assert.deepEqual(target, { tests: ['test:ring-health'] });
  });

  it('win over an empty key of the same name in the advanced overlay', () => {
    const { productSdk } = splitRunOptions(
      parseDispatchInputs({
        ...dispatch({ product_sdk: '@parity/product-sdk-individuality@0.10.1-dev.453.0' }),
        GATE_ADVANCED: '{"product_sdk":"","tests":["test:pop-gate"]}',
      }).target
    );
    assert.equal(productSdk, '@parity/product-sdk-individuality@0.10.1-dev.453.0');
  });

  it('reject a value that is not a string', () => {
    assert.throws(
      () => splitRunOptions({ product_sdk: ['@parity/product-sdk@0.43.0'] }),
      /"product_sdk" in the advanced overlay must be a string/
    );
  });

  it('client builds alone leave a steady-state run on the live runtimes', () => {
    const { truapi, target } = splitRunOptions(parseDispatchInputs(dispatch({ truapi: '0.29.0-rc.1' })).target);
    assert.equal(truapi, '0.29.0-rc.1');
    assert.equal(target, null);
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
        runtime_individuality: 'paritytech/individuality-community@v0.3.1',
        runtime_bulletin: 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo',
      })
    );
    validateManifest(mergeTarget(manifest('previewnet'), target));
  });

  // The call polkadot-sdk makes: every Westend runtime and node binary from its own run.
  it('merges a westend request built in the calling run', () => {
    const { target } = parseDispatchInputs(
      dispatch({
        binary_polkadot: 'artifact:node-binaries',
        binary_polkadot_parachain: 'artifact:node-binaries',
        runtime_relay: 'artifact:westend-runtimes',
        runtime_asset_hub: 'artifact:westend-runtimes',
        runtime_people: 'artifact:westend-runtimes',
      })
    );
    const merged = validateManifest(mergeTarget(manifest('westend'), target));
    assert.equal(merged.binaries['polkadot-parachain'], 'artifact:node-binaries');
  });

  it('rejects a polkadot-parachain pin on a network whose parachains run omni-node', () => {
    const { target } = parseDispatchInputs(
      dispatch({ binary_polkadot_parachain: 'paritytech/polkadot-sdk@polkadot-stable2609-1' })
    );
    assert.throws(() => mergeTarget(manifest('previewnet'), target), /binary slot "polkadot-parachain" absent/);
  });

  it('rejects a chain the network does not run', () => {
    const { target } = parseDispatchInputs(
      dispatch({ runtime_web3_storage: 'paritytech/web3-storage@v0.4.2-paseo' })
    );
    assert.throws(() => mergeTarget(manifest('devnet'), target), /web3-storage/);
  });
});
