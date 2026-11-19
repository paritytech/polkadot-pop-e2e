// Tests for environments/node-scan.mjs — run with `pnpm test:environments`. Every endpoint
// is a stub: no RPC, no HTTP, and git is a canned ls-remote listing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommit, parseLsRemoteTags, scanNodes, sdkTagLoader } from './node-scan.mjs';

const STABLE2509_COMMIT = 'a'.repeat(40);
const STABLE2512_COMMIT = 'b'.repeat(40);
const LS_REMOTE = [
  `${STABLE2509_COMMIT}\trefs/tags/polkadot-stable2509`,
  `${'c'.repeat(40)}\trefs/tags/polkadot-stable2512`, // annotated: the tag object, then its commit
  `${STABLE2512_COMMIT}\trefs/tags/polkadot-stable2512^{}`,
].join('\n');
const TAGS = parseLsRemoteTags(LS_REMOTE);

const manifest = {
  network: 'previewnet',
  chains: { relay: {}, people: {} },
  binaries: { polkadot: 'paritytech/polkadot-sdk@polkadot-stable2509' },
  services: { 'eth-rpc': 'paritytech/polkadot-sdk@polkadot-stable2509', kubo: 'ipfs/kubo@v0.30.0' },
};
const versions = { relay: `1.20.0-${STABLE2509_COMMIT.slice(0, 11)}`, people: `1.21.0-weekly2026w38-${STABLE2512_COMMIT.slice(0, 7)}` };
const rpc = async (url, method) => {
  assert.equal(method, 'system_version');
  const chain = url.includes('people') ? 'people' : 'relay';
  return versions[chain];
};
const ethOk = async (_url, init) => {
  assert.equal(JSON.parse(init.body).method, 'web3_clientVersion');
  return { ok: true, json: async () => ({ result: 'eth-rpc/HEAD-deadbee/x86_64-unknown-linux-gnu/rustc1.93.0' }) };
};
const scan = (io = {}) => scanNodes(manifest, { rpc, loadTags: async () => TAGS, fetch: ethOk, ...io });

describe('node-scan', () => {
  it('parses the commit from node and eth-rpc versions', () => {
    for (const [version, commit] of [
      ['1.24.3-weekly2026w38-EEB597F61B9', 'eeb597f61b9'],
      ['1.25.1-6ab53982513', '6ab53982513'],
      ['eth-rpc/HEAD-eeb597f/x86_64-unknown-linux-gnu/rustc1.93.0', 'eeb597f'],
      ['eth-rpc/mr/eth-rpc-avoid-state-call-fe2ecd3/x86_64-unknown-linux-gnu/rustc1.93.0', 'fe2ecd3'],
      ['1.24.3', null],
      ['parity-polkadot', null],
      [undefined, null],
    ]) {
      assert.equal(parseCommit(version), commit, String(version));
    }
  });

  it('maps an annotated tag to the commit it points at', () => {
    assert.deepEqual([...TAGS], [[STABLE2509_COMMIT, ['polkadot-stable2509']], [STABLE2512_COMMIT, ['polkadot-stable2512']]]);
  });

  it('runs one ls-remote per run', async () => {
    let calls = 0;
    const load = sdkTagLoader(async () => (calls++, { stdout: LS_REMOTE }));
    await Promise.all([load(), load()]);
    assert.equal(calls, 1);
  });

  it('reports match, drift, untagged and the services it cannot read', async () => {
    assert.deepEqual(await scan(), [
      `- relay (polkadot): pinned paritytech/polkadot-sdk@polkadot-stable2509, live ${versions.relay}, match`,
      `- people (polkadot-omni-node): pinned nothing, live polkadot-stable2512 (${versions.people})`,
      '- eth-rpc: pinned paritytech/polkadot-sdk@polkadot-stable2509, live eth-rpc/HEAD-deadbee/x86_64-unknown-linux-gnu/rustc1.93.0, no polkadot-sdk tag has commit deadbee',
      '- not scanned: kubo',
    ]);
  });

  it('turns a failed or unreadable reply into its own line', async () => {
    const lines = await scan({
      rpc: async (url) => (url.includes('people') ? 'parity-polkadot' : Promise.reject(new Error('refused'))),
      fetch: async () => ({ ok: false, status: 502 }),
    });
    assert.match(lines[0], /relay .*unreachable: refused$/);
    assert.match(lines[1], /people .*unrecognised version "parity-polkadot"$/);
    assert.match(lines[2], /eth-rpc: .*unreachable: HTTP 502$/);
  });
});
