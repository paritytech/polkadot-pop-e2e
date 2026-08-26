// Tests for environments/release-map.mjs — run with `pnpm test:environments`.
//
// The failure modes pinned here are all silent-pass shaped: a manifest pointing a
// chain at the wrong repo (would gate the wrong artifact), chains sharing the
// engine's single binary file while pinning different releases (a promise no spawn
// can honor), unknown chains/networks (would converge nothing and read as green),
// and candidate fan-out that under- or over-produces.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHAINS,
  NODE_BINARIES,
  SERVICES,
  allowedSources,
  binaryPlan,
  candidateMatrix,
  mergeTarget,
  envTagPins,
  parseReleaseRef,
  platformAssetSuffix,
  ppnOverrides,
  runtimePlan,
  transitions,
  validateManifest,
} from './release-map.mjs';

// A bulletin pin production can never catch up to. The fan-out and transition
// fixtures below need a runtime that DIFFERS from the canonical manifest; they
// used to hardcode a real tag, so when the baseline scan bumped the manifest to
// that same tag (2026-08-24) the "bump" quietly became a no-op and three tests
// started asserting the collapsed shape instead of the fan-out. A tag no release
// will ever carry keeps the fixture honest whatever production does.
const UNREACHABLE_BULLETIN = 'paritytech/polkadot-bulletin-chain@v9.9.9-paseo';

const previewnet = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'networks', 'previewnet.json'), 'utf8')
);

const withChain = (m, chain, patch) => ({
  ...m,
  chains: { ...m.chains, [chain]: { ...m.chains[chain], ...patch } },
});

describe('parseReleaseRef', () => {
  it('splits owner/repo@tag, accepting "latest" and dotted tags', () => {
    assert.deepEqual(parseReleaseRef('paritytech/polkadot-bulletin-chain@v0.0.22-paseo'), {
      repo: 'paritytech/polkadot-bulletin-chain',
      tag: 'v0.0.22-paseo',
    });
    assert.equal(parseReleaseRef('ipfs/kubo@latest').tag, 'latest');
  });

  it('rejects refs without a repo or tag', () => {
    assert.throws(() => parseReleaseRef('preview-net-v1@v1'), /expected owner\/repo@tag/);
    assert.throws(() => parseReleaseRef('paritytech/repo'), /expected owner\/repo@tag/);
  });
});

describe('the checked-in previewnet manifest', () => {
  it('validates and produces a full runtime plan', () => {
    validateManifest(previewnet);
    const plan = runtimePlan(previewnet);
    assert.deepEqual(
      plan.map((p) => p.chain).sort(),
      Object.keys(CHAINS.previewnet).sort()
    );
  });

  it('emits every slot and override-service pin as comma-separated PPN_BINARIES entries', () => {
    const entries = ppnOverrides(previewnet).split(',');
    assert.deepEqual(
      entries.map((e) => e.split('=')[0]).sort(),
      ['eth-rpc', 'polkadot', 'polkadot-omni-node']
    );
    assert.ok(entries.every((e) => /^[\w-]+=[\w.-]+\/[\w.-]+@\S+$/.test(e)), entries.join(','));
    assert.equal(entries.find((e) => e.startsWith('polkadot=')).split('=')[1], previewnet.binaries.polkadot);
  });

  it('downloads nothing itself — every pin is engine-delivered (overrides or env tags)', () => {
    const { plan } = binaryPlan(previewnet, '');
    assert.deepEqual(plan, []);
    // The canonical deliberately leaves identity-backend to the engine's default
    // tag — no DUB_TAG export on baseline runs.
    assert.deepEqual(envTagPins(previewnet), {});
    // A candidate override naming it exports DUB_TAG even though the canonical
    // doesn't pin it.
    const overridden = mergeTarget(previewnet, {
      services: { 'identity-backend': 'paritytech/device-uniqueness-backend@v0.4.0' },
    });
    assert.deepEqual(envTagPins(overridden), { DUB_TAG: 'v0.4.0' });
    assert.deepEqual(transitions(previewnet, overridden), [
      'identity-backend: (engine default) → paritytech/device-uniqueness-backend@v0.4.0',
    ]);
  });

  it('reports the not-yet-deliverable service pins instead of dropping them silently', () => {
    const { recorded } = binaryPlan(previewnet, '');
    assert.deepEqual(recorded.sort(), ['kubo', 'storage-provider-node']);
  });
});

describe('candidateMatrix', () => {
  const bumpBinaries = {
    ...previewnet,
    binaries: {
      ...previewnet.binaries,
      'polkadot-omni-node': 'paritytech/polkadot-sdk@polkadot-stable2606-1',
    },
  };
  const bumpRuntimes = withChain(previewnet, 'bulletin', {
    runtime: UNREACHABLE_BULLETIN,
  });
  const bumpBoth = withChain(bumpBinaries, 'bulletin', {
    runtime: UNREACHABLE_BULLETIN,
  });

  it('a both-dimensions PR fans out into target plus two informational cross terms', () => {
    const matrix = candidateMatrix(previewnet, bumpBoth);
    assert.deepEqual(matrix.map((c) => [c.id, c.gating]), [
      ['target', true],
      ['binaries-only', false],
      ['runtimes-only', false],
    ]);
    const binariesOnly = matrix.find((c) => c.id === 'binaries-only').manifest;
    assert.equal(binariesOnly.binaries['polkadot-omni-node'], bumpBoth.binaries['polkadot-omni-node']);
    assert.equal(binariesOnly.chains.bulletin.runtime, previewnet.chains.bulletin.runtime);
    const runtimesOnly = matrix.find((c) => c.id === 'runtimes-only').manifest;
    assert.equal(runtimesOnly.binaries['polkadot-omni-node'], previewnet.binaries['polkadot-omni-node']);
    assert.equal(runtimesOnly.chains.bulletin.runtime, bumpBoth.chains.bulletin.runtime);
  });

  it('a single-dimension PR collapses to one gating run', () => {
    assert.deepEqual(candidateMatrix(previewnet, bumpBinaries).map((c) => c.id), ['target']);
    assert.deepEqual(candidateMatrix(previewnet, bumpRuntimes).map((c) => c.id), ['target']);
  });

  it('no base (dispatch), no pin movement, and chain-set changes all mean a single run', () => {
    assert.deepEqual(candidateMatrix(null, previewnet).map((c) => c.id), ['target']);
    assert.deepEqual(candidateMatrix(previewnet, { ...previewnet }).map((c) => c.id), ['target']);
    const { relay, ...fewerChains } = bumpBoth.chains;
    assert.deepEqual(
      candidateMatrix(previewnet, { ...bumpBoth, chains: fewerChains }).map((c) => c.id),
      ['target']
    );
  });

  it('a service-only bump counts as the binaries dimension', () => {
    const bumpService = {
      ...previewnet,
      services: { ...previewnet.services, 'eth-rpc': 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
    };
    assert.deepEqual(candidateMatrix(previewnet, bumpService).map((c) => c.id), ['target']);
    const matrix = candidateMatrix(previewnet, {
      ...bumpService,
      chains: bumpRuntimes.chains,
    });
    assert.deepEqual(matrix.map((c) => c.id), ['target', 'binaries-only', 'runtimes-only']);
    assert.deepEqual(matrix.find((c) => c.id === 'runtimes-only').manifest.services, previewnet.services);
  });

  it('every candidate carries a purpose and its tested transitions for the run summary', () => {
    for (const c of candidateMatrix(previewnet, bumpBoth)) {
      assert.ok(c.purpose.length > 10, c.id);
      assert.ok(c.transitions.length >= 1, c.id);
    }
    const steady = candidateMatrix(previewnet, { ...previewnet });
    assert.match(steady[0].transitions[0], /steady state/);
  });
});

describe('target overlays (X = canonical, Y = canonical ⊕ target)', () => {
  it('merges a sparse ask onto the canonical, leaving everything else untouched', () => {
    const effective = mergeTarget(previewnet, {
      chains: { bulletin: { runtime: UNREACHABLE_BULLETIN } },
    });
    assert.equal(effective.chains.bulletin.runtime, UNREACHABLE_BULLETIN);
    assert.deepEqual(effective.binaries, previewnet.binaries);
    assert.deepEqual(effective.chains.relay, previewnet.chains.relay);
    assert.deepEqual(effective.services, previewnet.services);
    validateManifest(effective);
  });

  it('patches a binary slot once, for every chain that execs it', () => {
    const effective = mergeTarget(previewnet, {
      binaries: { 'polkadot-omni-node': 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
    });
    assert.equal(effective.binaries['polkadot-omni-node'], 'paritytech/polkadot-sdk@polkadot-stable2606-1');
    assert.equal(effective.binaries.polkadot, previewnet.binaries.polkadot);
    validateManifest(effective);
    assert.throws(
      () => mergeTarget(previewnet, { binaries: { 'polkadot-parachain': 'a/b@v1' } }),
      /target names binary slot "polkadot-parachain"/
    );
    assert.throws(
      () => mergeTarget(previewnet, { chains: { bulletin: { binary: 'a/b@v1' } } }),
      /binaries are pinned per slot/
    );
  });

  it('no target means the effective manifest IS the canonical — a steady-state run', () => {
    assert.deepEqual(mergeTarget(previewnet, null), previewnet);
    assert.deepEqual(candidateMatrix(previewnet, mergeTarget(previewnet, null)).map((c) => c.id), ['target']);
  });

  it('rejects a target naming unknown chains or services', () => {
    assert.throws(
      () => mergeTarget(previewnet, { chains: { coretime: { runtime: 'a/b@v1' } } }),
      /target names chain "coretime"/
    );
    assert.throws(
      () => mergeTarget(previewnet, { services: { smoldot: 'a/b@v1' } }),
      /target names service "smoldot"/
    );
  });

  it('reports exactly the moved pins as transitions', () => {
    const effective = mergeTarget(previewnet, {
      chains: { bulletin: { runtime: UNREACHABLE_BULLETIN } },
      services: { 'eth-rpc': 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
    });
    assert.deepEqual(transitions(previewnet, effective), [
      `bulletin: runtime ${previewnet.chains.bulletin.runtime} → ${UNREACHABLE_BULLETIN}`,
      `eth-rpc: ${previewnet.services['eth-rpc']} → paritytech/polkadot-sdk@polkadot-stable2606-1`,
    ]);
  });
});

describe('guard rails', () => {
  it('rejects an unknown network, non-fork base, and empty tests', () => {
    assert.throws(() => validateManifest({ ...previewnet, network: 'kusama' }), /unknown network/);
    assert.throws(() => validateManifest({ ...previewnet, base: 'genesis' }), /only "fork"/);
    assert.throws(() => validateManifest({ ...previewnet, tests: [] }), /non-empty array/);
  });

  it('rejects a chain the network does not have, and a chain missing its runtime pin', () => {
    assert.throws(
      () => validateManifest({ ...previewnet, chains: { ...previewnet.chains, coretime: previewnet.chains.relay } }),
      /unknown chain "coretime"/
    );
    assert.throws(
      () => validateManifest(withChain(previewnet, 'relay', { runtime: undefined })),
      /must pin a "runtime"/
    );
  });

  it('rejects per-chain binary pins and unpinned or unknown slots', () => {
    assert.throws(
      () => validateManifest(withChain(previewnet, 'bulletin', { binary: 'a/b@v1' })),
      /binaries are pinned once per engine binary slot/
    );
    const { polkadot, ...missingRelay } = previewnet.binaries;
    assert.throws(
      () => validateManifest({ ...previewnet, binaries: missingRelay }),
      /must pin "polkadot"/
    );
    assert.throws(
      () => validateManifest({ ...previewnet, binaries: { ...previewnet.binaries, 'polkadot-parachain': 'a/b@v1' } }),
      /unknown slot "polkadot-parachain"/
    );
  });

  it('rejects a runtime pointed at a repo outside the chain allow-list', () => {
    assert.throws(
      () => runtimePlan(withChain(previewnet, 'bulletin', { runtime: 'paritytech/web3-storage@v1' })),
      /bulletin runtime must come from paritytech\/polkadot-bulletin-chain/
    );
  });

  it('renders the allow-lists for testers, straight from the enforced tables', () => {
    const text = allowedSources('previewnet');
    assert.match(text, /binary polkadot \(runs relay\) from paritytech\/preview-net-v1 or paritytech\/polkadot-sdk/);
    assert.match(text, /binary polkadot-omni-node \(runs asset-hub, people, bulletin, web3-storage\) from paritytech\/preview-net-v1 or paritytech\/polkadot-sdk/);
    assert.match(text, /people: runtime from paritytech\/preview-net-v1 or paritytech\/individuality/);
    assert.match(text, /identity-backend: from paritytech\/device-uniqueness-backend/);
    assert.match(text, /kubo: from ipfs\/kubo \(pin recorded, not yet swapped\)/);
    assert.throws(() => allowedSources('nonexistent'), /unknown network/);
  });

  it('the issue template names every repo the map allows (drift check)', () => {
    const tpl = fs.readFileSync(
      new URL('../.github/ISSUE_TEMPLATE/release-gate.yml', import.meta.url),
      'utf8'
    );
    const repos = new Set();
    for (const chains of Object.values(CHAINS)) {
      for (const entry of Object.values(chains)) {
        for (const r of NODE_BINARIES[entry.node].repos) repos.add(r);
        for (const r of Object.keys(entry.runtime)) repos.add(r);
      }
    }
    for (const services of Object.values(SERVICES)) {
      // recordedOnly pins are not askable through the form — their repos need no mention.
      for (const svc of Object.values(services)) {
        if (!svc.recordedOnly) for (const r of svc.repos) repos.add(r);
      }
    }
    for (const repo of repos) {
      assert.ok(tpl.includes(repo), `issue template must mention allowed source ${repo}`);
    }
  });

  it('resolves the per-repo asset name for runtimes with several allowed sources', () => {
    // Pin every probed chain explicitly: the canonical manifest's repo choices are
    // the baseline scan's to rewrite, and this test is about the MAP's per-repo
    // asset resolution, not about what production happens to run today.
    const m = withChain(
      withChain(
        withChain(previewnet, 'people', { runtime: 'paritytech/individuality@v0.11.2' }),
        'asset-hub',
        { runtime: 'paritytech/individuality@v0.11.2' }
      ),
      'relay',
      { runtime: 'paseo-network/runtimes@v2.4.4' }
    );
    const plan = runtimePlan(m);
    const byChain = Object.fromEntries(plan.map((p) => [p.chain, p]));
    assert.equal(byChain.people.asset, 'next_people_paseo_runtime.compact.compressed.wasm');
    assert.equal(byChain['asset-hub'].asset, 'next_asset_hub_paseo_runtime.compact.compressed.wasm');
    assert.equal(
      byChain.relay.asset,
      'paseo_fast_runtime.compressed.wasm',
      'other chains keep their own source untouched (relay pins the fast build — previewnet runs 1-minute epochs)'
    );
  });

  it('catches disallowed repos at validate time, not in the gate job', () => {
    // The issue/dispatch flow only runs validateManifest(mergeTarget(...)) before
    // dispatching — a bad ask must die there, not on a beefy runner mid-run.
    assert.throws(
      () =>
        validateManifest(
          mergeTarget(previewnet, {
            binaries: { 'polkadot-omni-node': 'paritytech/individuality@v0.11.2' },
          })
        ),
      /polkadot-omni-node may come from/
    );
    assert.throws(
      () =>
        validateManifest(
          mergeTarget(previewnet, {
            chains: { relay: { runtime: 'paritytech/individuality@v0.11.2' } },
          })
        ),
      /relay runtime must come from paritytech\/preview-net-v1/
    );
  });

  it('accepts a slot from any repo in its allow-list', () => {
    const m = {
      ...previewnet,
      binaries: { ...previewnet.binaries, 'polkadot-omni-node': 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
    };
    assert.ok(
      ppnOverrides(m).split(',').includes('polkadot-omni-node=paritytech/polkadot-sdk@polkadot-stable2606-1')
    );
  });

  it('rejects a binary or service pinned outside its allow-list', () => {
    assert.throws(
      () =>
        binaryPlan({ ...previewnet, binaries: { ...previewnet.binaries, polkadot: 'paritytech/web3-storage@v1' } }, ''),
      /polkadot may come from/
    );
    assert.throws(
      () =>
        binaryPlan(
          { ...previewnet, services: { ...previewnet.services, smoldot: 'a/b@v1' } },
          ''
        ),
      /unknown service "smoldot"/
    );
  });

  it('knows the release-asset platform convention', () => {
    assert.equal(platformAssetSuffix('linux', 'x64'), '');
    assert.equal(platformAssetSuffix('darwin', 'arm64'), '-aarch64-apple-darwin');
    assert.throws(() => platformAssetSuffix('win32', 'x64'), /no release assets/);
  });

  it('assert-engine: agrees on a faithful show, names each kind of drift otherwise', async () => {
    const { assertEngineAgrees } = await import('./assert-engine.mjs');
    const ref = (pin) => {
      const at = pin.lastIndexOf('@');
      return { repo: pin.slice(0, at), tag: pin.slice(at + 1) };
    };
    const faithful = () => ({
      chains: Object.entries(CHAINS.previewnet).map(([key, e]) => ({
        key,
        binary: { name: e.node, ...ref(previewnet.binaries[e.node]), overridden: true },
      })),
      binaries: [{ name: 'eth-rpc', ...ref(previewnet.services['eth-rpc']) }],
    });

    assert.equal(assertEngineAgrees(previewnet, faithful()).errors.length, 0);

    const wiring = faithful();
    wiring.chains.find((c) => c.key === 'bulletin').binary.name = 'polkadot-bulletin-chain';
    assert.match(assertEngineAgrees(previewnet, wiring).errors[0], /wiring drift.*bulletin/);

    const stale = faithful();
    stale.chains.find((c) => c.key === 'relay').binary.tag = 'someother';
    assert.match(assertEngineAgrees(previewnet, stale).errors[0], /engine will run .*someother/);

    const unapplied = faithful();
    delete unapplied.chains.find((c) => c.key === 'relay').binary.overridden;
    assert.match(assertEngineAgrees(previewnet, unapplied).errors[0], /not via our override/);

    const extra = faithful();
    extra.chains.push({ key: 'coretime', binary: { name: 'polkadot-omni-node' } });
    assert.match(assertEngineAgrees(previewnet, extra).errors[0], /chain "coretime" the map does not know/);

    const svc = faithful();
    svc.binaries = [];
    assert.match(assertEngineAgrees(previewnet, svc).errors[0], /does not fetch a binary named "eth-rpc"/);
  });

  it('map integrity: every chain has a node slot and exact runtime assets per repo', () => {
    for (const [network, chains] of Object.entries(CHAINS)) {
      for (const [chain, entry] of Object.entries(chains)) {
        assert.ok(NODE_BINARIES[entry.node], `${network}/${chain} node slot`);
        const sources = Object.entries(entry.runtime);
        assert.ok(sources.length > 0, `${network}/${chain} has a runtime source`);
        for (const [repo, asset] of sources) {
          assert.match(repo, /^[\w.-]+\/[\w.-]+$/, `${network}/${chain} runtime repo`);
          assert.match(asset, /\.wasm$/, `${network}/${chain} runtime asset for ${repo}`);
        }
      }
      assert.ok(SERVICES[network], `${network} has services`);
      for (const [name, source] of Object.entries(SERVICES[network])) {
        assert.ok(source.repos?.length, `${network}/${name} has an allow-list`);
        assert.ok(
          source.recordedOnly || source.override || source.envTag || source.files?.length,
          `${network}/${name} has a delivery kind`
        );
      }
    }
  });
});
