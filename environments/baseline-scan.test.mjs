import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, scanManifest, applyDrift, renderSummary } from './baseline-scan.mjs';

const CODE_LIVE = Buffer.from('live-runtime-bytes');
const CODE_OLD = Buffer.from('old-runtime-bytes!');

const previewnetManifest = () => ({
  network: 'previewnet',
  base: 'fork',
  binaries: {
    polkadot: 'paritytech/release-automation@w1',
    'polkadot-omni-node': 'paritytech/release-automation@w1',
  },
  chains: {
    relay: { runtime: 'paseo-network/runtimes@v2.4.4' },
    'asset-hub': { runtime: 'paritytech/individuality-community@v0.12.0-previewnet' },
    people: { runtime: 'paritytech/individuality-community@v0.12.0-previewnet' },
    bulletin: { runtime: 'paritytech/polkadot-bulletin-chain@v0.0.25-paseo' },
    'web3-storage': { runtime: 'paritytech/web3-storage@v0.4.1-paseo' },
  },
  tests: ['test:network-health'],
});

// A fake GitHub: repo -> releases (newest first), each with named assets and bytes.
function fakeIo({ liveCode, releasesByRepo }) {
  const assetBytes = new Map();
  const listReleases = async (repo) =>
    (releasesByRepo[repo] ?? []).map((r) => ({
      tag_name: r.tag,
      assets: Object.entries(r.assets).map(([name, bytes]) => {
        const key = `${repo}@${r.tag}/${name}`;
        assetBytes.set(key, bytes);
        return { name, size: bytes.length, url: key };
      }),
    }));
  const getRelease = async (repo, tag) => {
    const all = await listReleases(repo);
    const hit = all.find((r) => r.tag_name === tag);
    if (!hit) throw new Error(`no release ${repo}@${tag}`);
    return hit;
  };
  const downloadAssetBytes = async (asset) => assetBytes.get(asset.url);
  const observeChain = async () => ({ specName: 'spec', specVersion: 9, block: 42, code: liveCode });
  const io = { listReleases, getRelease, downloadAssetBytes, observeChain };
  io.attribute = (sources, live, policy) => attribute(sources, live, policy, io);
  return io;
}

const liveOf = (code) => ({ specName: 'spec', specVersion: 9, block: 42, code });

describe('attribute', () => {
  it('byte-matches the live code to a release across the allow-list, newest first', async () => {
    const io = fakeIo({
      liveCode: CODE_LIVE,
      releasesByRepo: {
        'paritytech/individuality-community': [
          { tag: 'v0.13.0', assets: { 'next_people_paseo_runtime.compact.compressed.wasm': CODE_LIVE } },
          { tag: 'v0.12.0', assets: { 'next_people_paseo_runtime.compact.compressed.wasm': CODE_OLD } },
        ],
      },
    });
    const hit = await attribute(
      { 'paritytech/individuality-community': 'next_people_paseo_runtime.compact.compressed.wasm' },
      liveOf(CODE_LIVE),
      'bytes',
      io
    );
    assert.deepEqual(hit, { repo: 'paritytech/individuality-community', tag: 'v0.13.0' });
  });

  it('skips same-name assets whose size differs without downloading, and returns null on no match', async () => {
    let downloads = 0;
    const io = fakeIo({
      liveCode: CODE_LIVE,
      releasesByRepo: {
        'paritytech/individuality-community': [
          { tag: 'v9', assets: { 'a.wasm': Buffer.from('x') } }, // wrong size — must not download
        ],
      },
    });
    const inner = io.downloadAssetBytes;
    io.downloadAssetBytes = (a) => (downloads++, inner(a));
    const hit = await attribute({ 'paritytech/individuality-community': 'a.wasm' }, liveOf(CODE_LIVE), 'bytes', io);
    assert.equal(hit, null);
    assert.equal(downloads, 0);
  });
});

describe('scanManifest', () => {
  const releasesByRepo = {
    // pinned tags exist and carry the OLD bytes; the newer tag carries live bytes
    'paseo-network/runtimes': [
      { tag: 'v2.4.5', assets: { 'paseo_fast_runtime.compressed.wasm': CODE_LIVE } },
      { tag: 'v2.4.4', assets: { 'paseo_fast_runtime.compressed.wasm': CODE_OLD } },
    ],
    'paritytech/individuality-community': [
      { tag: 'v0.12.1-previewnet', assets: {
        'next_asset_hub_paseo_runtime.compact.compressed.wasm': CODE_LIVE,
        'next_people_paseo_runtime.compact.compressed.wasm': CODE_LIVE,
      } },
      { tag: 'v0.12.0-previewnet', assets: {
        'next_asset_hub_paseo_runtime.compact.compressed.wasm': CODE_OLD,
        'next_people_paseo_runtime.compact.compressed.wasm': CODE_OLD,
      } },
    ],
    'paritytech/polkadot-bulletin-chain': [
      { tag: 'v0.0.25-paseo', assets: { 'bulletin_paseo_runtime.compact.compressed.wasm': CODE_LIVE } },
    ],
    'paritytech/web3-storage': [
      { tag: 'v0.4.1-paseo', assets: { 'storage_paseo_runtime.compact.compressed.wasm': CODE_LIVE } },
    ],
  };

  it('classifies match vs drift per chain and attributes drift by byte equality', async () => {
    const io = fakeIo({ liveCode: CODE_LIVE, releasesByRepo });
    const results = await scanManifest(previewnetManifest(), io);
    const byChain = Object.fromEntries(results.map((r) => [r.chain, r]));
    assert.equal(byChain.bulletin.verdict, 'match');
    assert.equal(byChain['web3-storage'].verdict, 'match');
    assert.equal(byChain.relay.verdict, 'drift');
    assert.equal(byChain.relay.attributed, 'paseo-network/runtimes@v2.4.5');
    assert.equal(byChain['asset-hub'].attributed, 'paritytech/individuality-community@v0.12.1-previewnet');
    assert.equal(byChain.people.observed.block, 42);
  });

  it('reports unattributed when no allow-listed release carries the live bytes', async () => {
    const io = fakeIo({
      liveCode: Buffer.from('bytes-nobody-published'),
      releasesByRepo,
    });
    const results = await scanManifest(previewnetManifest(), io);
    assert.ok(results.every((r) => r.verdict === 'unattributed'));
  });

  it('reports unreachable endpoints instead of throwing the whole scan away', async () => {
    const io = fakeIo({ liveCode: CODE_LIVE, releasesByRepo });
    io.observeChain = async () => {
      throw new Error('connection failed');
    };
    const results = await scanManifest(previewnetManifest(), io);
    assert.ok(results.every((r) => r.verdict === 'unreachable'));
    assert.match(results[0].error, /connection failed/);
  });
});

describe('scanManifest with scanPolicy: spec (public relay)', () => {
  // A minimal raw wasm whose runtime_version custom section declares the given
  // spec — what runtimeSpecOf reads from real artifacts, without compression.
  function wasmDeclaring(specName, specVersion) {
    const scaleStr = (s) => Buffer.concat([Buffer.from([s.length << 2]), Buffer.from(s)]);
    const payloadBody = Buffer.concat([
      scaleStr(specName),
      scaleStr('impl'),
      Buffer.from([1, 0, 0, 0]), // authoring_version
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(specVersion);
        return b;
      })(),
    ]);
    const name = Buffer.from('runtime_version');
    const section = Buffer.concat([Buffer.from([name.length]), name, payloadBody]);
    return Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), // magic + version
      Buffer.from([0, section.length]),
      section,
    ]);
  }

  const relayManifest = { network: 'devnet', chains: { relay: { runtime: 'paseo-network/runtimes@v2.4.4' } } };
  const releasesByRepo = {
    'paseo-network/runtimes': [
      { tag: 'v2.4.5', assets: { 'paseo_runtime.compressed.wasm': wasmDeclaring('paseo', 10) } },
      { tag: 'v2.4.4', assets: { 'paseo_runtime.compressed.wasm': wasmDeclaring('paseo', 9) } },
    ],
  };

  it('matches on declared spec even when the deployed bytes differ from every asset', async () => {
    const io = fakeIo({ liveCode: Buffer.from('deployed-blob-nobody-published'), releasesByRepo });
    io.observeChain = async () => ({ specName: 'paseo', specVersion: 9, block: 7, code: Buffer.from('deployed-blob-nobody-published') });
    const [relay] = await scanManifest(relayManifest, io);
    assert.equal(relay.verdict, 'match');
    assert.equal(relay.policy, 'spec');
  });

  it('attributes drift to the release declaring the live spec', async () => {
    const io = fakeIo({ liveCode: Buffer.from('deployed-blob-nobody-published'), releasesByRepo });
    io.observeChain = async () => ({ specName: 'paseo', specVersion: 10, block: 7, code: Buffer.from('deployed-blob-nobody-published') });
    const [relay] = await scanManifest(relayManifest, io);
    assert.equal(relay.verdict, 'drift');
    assert.equal(relay.attributed, 'paseo-network/runtimes@v2.4.5');
  });
});

describe('applyDrift', () => {
  it('rewrites exactly the drifted pins', async () => {
    const manifest = previewnetManifest();
    const changed = applyDrift(manifest, [
      { chain: 'relay', verdict: 'drift', attributed: 'paseo-network/runtimes@v2.4.5' },
      { chain: 'bulletin', verdict: 'match' },
      { chain: 'people', verdict: 'unattributed' },
    ]);
    assert.deepEqual(changed, ['relay']);
    assert.equal(manifest.chains.relay.runtime, 'paseo-network/runtimes@v2.4.5');
    assert.equal(manifest.chains.people.runtime, 'paritytech/individuality-community@v0.12.0-previewnet');
  });
});

describe('renderSummary', () => {
  it('names the failure a human must act on', () => {
    const text = renderSummary('previewnet', [
      {
        chain: 'people',
        verdict: 'unattributed',
        pin: 'paritytech/individuality-community@v0.12.0-previewnet',
        observed: { specName: 'next-people-paseo', specVersion: 1000037, block: 7 },
      },
    ]);
    assert.match(text, /production runs bytes NO allow-listed release carries/);
    assert.match(text, /1000037/);
  });
});
