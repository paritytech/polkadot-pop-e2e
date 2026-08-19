// The issue-form parser: field-per-override in, sparse target overlay out.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueForm } from './issue-form.mjs';
import { mergeTarget, validateManifest } from './release-map.mjs';
import fs from 'node:fs';
import path from 'node:path';

const body = (fields) =>
  Object.entries(fields)
    .map(([label, value]) => `### ${label}\n\n${value}\n`)
    .join('\n');

describe('issue-form parsing', () => {
  it('assembles the overlay from individual fields, skipping empty ones', () => {
    const { network, target } = parseIssueForm(
      body({
        Network: 'previewnet',
        'Node binary: polkadot': 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        'Node binary: polkadot-omni-node': '_No response_',
        'Runtime: people': 'paritytech/individuality@v0.12.0',
        'Service: eth-rpc': '_No response_',
      })
    );
    assert.equal(network, 'previewnet');
    assert.deepEqual(target, {
      binaries: { polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
      chains: { people: { runtime: 'paritytech/individuality@v0.12.0' } },
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
        'Runtime: people': 'paritytech/individuality@v0.12.0',
        'Advanced: raw target overlay (JSON)':
          '```json\n{"chains":{"relay":{"runtime":"paseo-network/runtimes@v2.4.5"}}}\n```',
      })
    );
    assert.deepEqual(target, { chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.5' } } });
  });

  it('a field-assembled overlay merges and validates against the canonical', () => {
    const previewnet = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, 'networks', 'previewnet.json'), 'utf8')
    );
    const { target } = parseIssueForm(
      body({
        Network: 'previewnet',
        'Node binary: polkadot': 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        'Node binary: polkadot-omni-node': 'paritytech/polkadot-sdk@polkadot-stable2606-1',
        'Runtime: bulletin': 'paritytech/polkadot-bulletin-chain@v0.0.24-paseo',
      })
    );
    validateManifest(mergeTarget(previewnet, target));
  });

  it('rejects a body with no network', () => {
    assert.throws(() => parseIssueForm('### Something else\n\nvalue\n'), /names no network/);
  });
});
