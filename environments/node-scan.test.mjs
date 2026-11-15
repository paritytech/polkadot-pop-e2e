// Tests for environments/node-scan.mjs — run with `pnpm test:environments`.
// Every endpoint is a stub: no RPC, no HTTP, and git is a canned ls-remote listing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHAINS, SERVICES } from './release-map.mjs';
import {
  ETH_RPC_URLS,
  commitGroups,
  parseEthRpcVersion,
  parseLsRemoteTags,
  parseNodeVersion,
  pickTag,
  renderNodeSummary,
  resolveCommit,
  scanNodes,
  sdkTagLoader,
} from './node-scan.mjs';

// Full 40-hex commits built from the short ones the release notes quote.
const sha = (prefix) => (prefix + '0'.repeat(40)).slice(0, 40);
const W33 = sha('253fa818f2b'); // polkadot-weekly2026w33-rc2 and -rc3
const STABLE = sha('6ab53982513'); // polkadot-stable2609-1, polkadot-v1.25.1
const W38 = sha('eeb597f61b9'); // polkadot-weekly2026w38-rc1
const TAG_OBJECT = sha('1a2b3c4d5e6f'); // annotated tag object, NOT a commit

// The shape `git ls-remote --tags` prints, annotated tags included.
const LS_REMOTE = [
  `${W33}\trefs/tags/polkadot-weekly2026w33-rc2`,
  `${W33}\trefs/tags/polkadot-weekly2026w33-rc3`,
  `${TAG_OBJECT}\trefs/tags/polkadot-stable2609-1`,
  `${STABLE}\trefs/tags/polkadot-stable2609-1^{}`,
  `${sha('9f8e7d6c5b4a')}\trefs/tags/polkadot-v1.25.1`,
  `${STABLE}\trefs/tags/polkadot-v1.25.1^{}`,
  `${W38}\trefs/tags/polkadot-weekly2026w38-rc1`,
  'not a ref line',
].join('\n');

const tags = () => parseLsRemoteTags(LS_REMOTE);

describe('parseNodeVersion', () => {
  it('reads the commit of a weekly build (with a label) and of a stable build (without)', () => {
    assert.equal(parseNodeVersion('1.24.3-weekly2026w38-eeb597f61b9'), 'eeb597f61b9');
    assert.equal(parseNodeVersion('1.25.1-6ab53982513'), '6ab53982513');
  });

  it('rejects garbage, operator-set names, versions with no commit and short commits', () => {
    for (const bad of ['Parity Polkadot', 'polkadot-omni-node', '1.25.1', '1.25.1-xyz', '1.25.1-6ab5398x', '1.25.1-abc', '', undefined, 42]) {
      assert.equal(parseNodeVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseEthRpcVersion', () => {
  it('reads the commit of a HEAD build and of a branch build whose ref contains slashes', () => {
    assert.equal(parseEthRpcVersion('eth-rpc/HEAD-eeb597f/x86_64-unknown-linux-gnu/rustc1.93.0'), 'eeb597f');
    assert.equal(
      parseEthRpcVersion('eth-rpc/mr/eth-rpc-avoid-state-call-fe2ecd3/x86_64-unknown-linux-gnu/rustc1.93.0'),
      'fe2ecd3'
    );
  });

  it('rejects garbage and refs with no commit', () => {
    for (const bad of ['', 'polkadot 1.2.3', 'eth-rpc/HEAD', 'eth-rpc/HEAD-zzz/x/rustc1', 7]) {
      assert.equal(parseEthRpcVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('parseLsRemoteTags', () => {
  it('maps each commit to its tags, taking an annotated tag\'s commit from its ^{} line', () => {
    const t = tags();
    assert.deepEqual(t.get(W33), ['polkadot-weekly2026w33-rc2', 'polkadot-weekly2026w33-rc3']);
    assert.deepEqual(t.get(STABLE), ['polkadot-stable2609-1', 'polkadot-v1.25.1']);
    assert.deepEqual(t.get(W38), ['polkadot-weekly2026w38-rc1']);
    assert.equal(t.has(TAG_OBJECT), false, 'a tag object is never a commit');
  });

  it('keeps a lightweight tag as its own commit', () => {
    assert.deepEqual(parseLsRemoteTags(`${W38}\trefs/tags/light-tag\n`).get(W38), ['light-tag']);
  });
});

describe('sdkTagLoader', () => {
  it('runs one ls-remote against polkadot-sdk however many callers ask', async () => {
    const calls = [];
    const load = sdkTagLoader({
      git: async (args) => {
        calls.push(args);
        return LS_REMOTE;
      },
    });
    const [a, b, c] = await Promise.all([load(), load(), load()]);
    assert.deepEqual(calls, [['ls-remote', '--tags', 'https://github.com/paritytech/polkadot-sdk']]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.deepEqual(a.get(W38), ['polkadot-weekly2026w38-rc1']);
  });
});

describe('resolveCommit', () => {
  it('resolves a short live commit to its full commit and that commit\'s tags', () => {
    assert.deepEqual(resolveCommit(tags(), 'eeb597f'), { commit: W38, releases: ['polkadot-weekly2026w38-rc1'] });
    assert.deepEqual(resolveCommit(tags(), '6ab5398'), {
      commit: STABLE,
      releases: ['polkadot-stable2609-1', 'polkadot-v1.25.1'],
    });
  });

  it('keeps the prefix and pools the tags when it matches several commits', () => {
    const ambiguous = new Map([
      [sha('ab12345'), ['a']],
      [sha('ab12399'), ['b']],
    ]);
    assert.deepEqual(resolveCommit(ambiguous, 'ab123'), { commit: 'ab123', releases: ['a', 'b'] });
  });

  it('finds no tags for a commit nothing points at', () => {
    assert.deepEqual(resolveCommit(tags(), 'abcdef1'), { commit: 'abcdef1', releases: [] });
  });
});

describe('pickTag', () => {
  it('returns the pinned tag when it is a candidate, even against the preference order', () => {
    assert.equal(
      pickTag(['polkadot-weekly2026w33-rc2', 'polkadot-weekly2026w33-rc3'], 'polkadot-weekly2026w33-rc3'),
      'polkadot-weekly2026w33-rc3'
    );
  });

  it('ignores a pinned tag that is not a candidate', () => {
    assert.equal(
      pickTag(['polkadot-v1.25.1', 'polkadot-stable2609-1'], 'polkadot-weekly2026w33-rc2'),
      'polkadot-stable2609-1'
    );
  });

  it('prefers a final release over an rc, stable/weekly over v-style tags, then lexical order', () => {
    assert.equal(pickTag(['polkadot-weekly2026w33-rc3', 'polkadot-v1.25.1']), 'polkadot-v1.25.1');
    assert.equal(pickTag(['polkadot-v1.25.1', 'polkadot-stable2609-1']), 'polkadot-stable2609-1');
    assert.equal(pickTag(['v1.25.1', 'polkadot-stable2609-1']), 'polkadot-stable2609-1');
    assert.equal(pickTag(['polkadot-weekly2026w33-rc3', 'polkadot-weekly2026w33-rc2']), 'polkadot-weekly2026w33-rc2');
    assert.equal(pickTag([]), null);
  });
});

// ── scanNodes: stubs ─────────────────────────────────────────────────────────

const PINNED = 'paritytech/release-automation@polkadot-weekly2026w33-rc2';
const W33_VERSION = '1.24.3-weekly2026w33-253fa818f2b';
const W38_VERSION = '1.24.3-weekly2026w38-eeb597f61b9';
const ETH_W33 = 'eth-rpc/HEAD-253fa81/x86_64-unknown-linux-gnu/rustc1.93.0';

const PREV = (chain) => CHAINS.previewnet[chain].ws;

// A manifest in the shape validateManifest accepts: every chain the network maps, both
// binary slots pinned to the same release, eth-rpc pinned.
const manifestFor = (network, overrides = {}) => ({
  network,
  base: 'fork',
  binaries: { polkadot: PINNED, 'polkadot-omni-node': PINNED },
  chains: Object.fromEntries(Object.keys(CHAINS[network]).map((c) => [c, { runtime: 'x' }])),
  services: { 'eth-rpc': PINNED },
  tests: ['test:network-health'],
  ...overrides,
});
const previewnet = (overrides) => manifestFor('previewnet', overrides);

// A fake network. `versions`, `names`, `fail` and `hang` key on endpoint URLs, `releases`
// on `repo@tag`. Anything not listed answers with the W33 build.
function fakeIo({
  versions = {},
  names = {},
  fail = {},
  hang = [],
  releases = {},
  releaseFail = null,
  ethResult = ETH_W33,
  ethFail = null,
  gitFail = null,
  delayMs = 0,
} = {}) {
  const calls = { git: 0, fetch: [], inFlight: 0, maxInFlight: 0 };
  const hangs = new Set(hang);
  return {
    calls,
    git: async () => {
      calls.git++;
      if (gitFail) throw new Error(gitFail);
      return LS_REMOTE;
    },
    rpc: async (url, method) => {
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (hangs.has(url)) return new Promise(() => {});
        if (fail[url]) throw new Error(fail[url]);
        if (method === 'system_name') {
          if (!(url in names)) throw new Error('system_name unavailable');
          return names[url];
        }
        if (method !== 'system_version') throw new Error(`unexpected method ${method}`);
        return url in versions ? versions[url] : W33_VERSION;
      } finally {
        calls.inFlight--;
      }
    },
    fetch: async (url, opts = {}) => {
      calls.fetch.push({ url, method: opts.method ?? 'GET', body: opts.body, signal: opts.signal });
      if (opts.method === 'POST') {
        if (ethFail) throw new Error(ethFail);
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: ethResult }) };
      }
      if (releaseFail) throw new Error(releaseFail);
      const m = /repos\/(.+?)\/releases\/tags\/(.+)$/.exec(url);
      const status = releases[`${m[1]}@${decodeURIComponent(m[2])}`] ?? 200;
      return { ok: status === 200, status, json: async () => ({}) };
    },
  };
}

const byChain = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
const OMNI = ['asset-hub', 'people', 'bulletin', 'web3-storage'];
const omniOn = (version) => Object.fromEntries(OMNI.map((c) => [PREV(c), version]));

// ── scanNodes: verdicts ──────────────────────────────────────────────────────

describe('scanNodes verdicts', () => {
  it('match: every chain and eth-rpc on the pinned commit, release present', async () => {
    const rows = await scanNodes(previewnet(), fakeIo());
    assert.deepEqual(
      rows.map((r) => [r.name, r.verdict]),
      [
        ['relay', 'match'],
        ['asset-hub', 'match'],
        ['people', 'match'],
        ['bulletin', 'match'],
        ['web3-storage', 'match'],
        ['eth-rpc', 'match'],
      ]
    );
    assert.ok(rows.every((r) => r.release?.state === 'present'));
  });

  it('drift: a slot on another release is attributed to the tag carrying the live commit', async () => {
    const versions = { ...omniOn(W38_VERSION), [PREV('relay')]: '1.25.1-6ab53982513' };
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ versions })));
    assert.equal(rows.relay.verdict, 'drift');
    assert.equal(rows.relay.attributed, 'polkadot-stable2609-1');
    for (const c of OMNI) {
      assert.equal(rows[c].verdict, 'drift', c);
      assert.equal(rows[c].attributed, 'polkadot-weekly2026w38-rc1', c);
    }
    assert.equal(rows['eth-rpc'].verdict, 'match');
  });

  it('unreleased: a live commit that no tag points at', async () => {
    const versions = { [PREV('relay')]: '1.24.3-weekly2026w99-abcdef1234' };
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ versions })));
    assert.equal(rows.relay.verdict, 'unreleased');
    assert.equal(rows.relay.commit, 'abcdef1234');
  });

  it('pin-unknown: the pinned tag names no polkadot-sdk commit', async () => {
    const m = previewnet({
      binaries: { polkadot: 'paritytech/release-automation@polkadot-weekly2099-rc1', 'polkadot-omni-node': PINNED },
    });
    const rows = byChain(await scanNodes(m, fakeIo()));
    assert.equal(rows.relay.verdict, 'pin-unknown');
    assert.equal(rows.relay.pin.reason, 'names no polkadot-sdk tag');
    assert.equal(rows['asset-hub'].verdict, 'match');
  });

  it('unparsed: a version string with no commit is reported, not guessed', async () => {
    const versions = { [PREV('people')]: 'polkadot-omni-node 1.0' };
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ versions })));
    assert.equal(rows.people.verdict, 'unparsed');
    assert.equal(rows['asset-hub'].verdict, 'match');
  });

  it('eth-rpc: a branch build is unreleased, and an HTTP failure is unreachable', async () => {
    const branch = 'eth-rpc/mr/eth-rpc-avoid-state-call-fe2ecd3/x86_64-unknown-linux-gnu/rustc1.93.0';
    const onBranch = byChain(await scanNodes(previewnet(), fakeIo({ ethResult: branch })));
    assert.equal(onBranch['eth-rpc'].verdict, 'unreleased');
    assert.equal(onBranch['eth-rpc'].commit, 'fe2ecd3');

    const down = byChain(await scanNodes(previewnet(), fakeIo({ ethFail: 'fetch failed' })));
    assert.equal(down['eth-rpc'].verdict, 'unreachable');
    assert.match(down['eth-rpc'].error, /previewnet\.substrate\.dev\/eth-rpc: fetch failed/);
  });

  it('eth-rpc is asked web3_clientVersion over an HTTP POST', async () => {
    const io = fakeIo();
    await scanNodes(previewnet(), io);
    const post = io.calls.fetch.find((c) => c.method === 'POST');
    assert.equal(post.url, ETH_RPC_URLS.previewnet);
    assert.equal(JSON.parse(post.body).method, 'web3_clientVersion');
  });

  it('scans only the chains the manifest lists, and eth-rpc only when pinned', async () => {
    const listed = await scanNodes(
      previewnet({ chains: { relay: { runtime: 'x' }, 'asset-hub': { runtime: 'x' } }, services: {} }),
      fakeIo()
    );
    assert.deepEqual(listed.map((r) => r.name), ['relay', 'asset-hub']);

    const unpinned = await scanNodes(previewnet({ services: {} }), fakeIo());
    assert.equal(unpinned.length, 5);
    assert.ok(unpinned.every((r) => r.kind === 'node'));
  });

  it('no-endpoint: a listed chain with no mapped endpoint is not queried and says so', async () => {
    const rows = byChain(
      await scanNodes(previewnet({ chains: { relay: { runtime: 'x' }, 'no-such-chain': { runtime: 'x' } }, services: {} }), fakeIo())
    );
    assert.equal(rows['no-such-chain'].verdict, 'no-endpoint');
    assert.equal(rows.relay.verdict, 'match');
    const text = renderNodeSummary('previewnet', Object.values(rows));
    assert.match(text, /^- no-such-chain \(\S+\): no scan endpoint mapped, report only$/m);
  });

  it('refuses an unknown network and a missing rpc', async () => {
    await assert.rejects(scanNodes({ network: 'nowhere' }, fakeIo()), /unknown network/);
    const { rpc: _ignored, ...noRpc } = fakeIo();
    await assert.rejects(scanNodes(previewnet(), noRpc), /needs io\.rpc/);
  });
});

// ── pins and release availability ────────────────────────────────────────────

describe('pin identity', () => {
  it('accepts a pin from polkadot-sdk as well as release-automation', async () => {
    const m = previewnet({ binaries: { polkadot: 'paritytech/polkadot-sdk@polkadot-weekly2026w33-rc2', 'polkadot-omni-node': PINNED } });
    const io = fakeIo();
    const rows = byChain(await scanNodes(m, io));
    assert.equal(rows.relay.verdict, 'match');
    assert.ok(io.calls.fetch.some((c) => c.url.includes('/repos/paritytech/polkadot-sdk/releases/tags/polkadot-weekly2026w33-rc2')));
  });

  it('pin-unknown when the repo is not allowed for the slot or the eth-rpc service, and the reason names the repo', async () => {
    const slot = byChain(
      await scanNodes(previewnet({ binaries: { polkadot: 'someone/fork@polkadot-weekly2026w33-rc2', 'polkadot-omni-node': PINNED } }), fakeIo())
    );
    assert.equal(slot.relay.verdict, 'pin-unknown');
    assert.equal(slot.relay.pin.reason, 'comes from someone/fork, not an allowed source for this slot');
    assert.equal(slot['asset-hub'].verdict, 'match');

    const eth = byChain(await scanNodes(previewnet({ services: { 'eth-rpc': 'someone/fork@polkadot-weekly2026w33-rc2' } }), fakeIo()));
    assert.equal(eth['eth-rpc'].verdict, 'pin-unknown');
  });
});

describe('release availability', () => {
  it('a missing pinned release is reported next to match, without changing the verdict', async () => {
    const io = fakeIo({ releases: { 'paritytech/release-automation@polkadot-weekly2026w33-rc2': 404 } });
    const rows = byChain(await scanNodes(previewnet(), io));
    assert.equal(rows.relay.verdict, 'match');
    assert.deepEqual(rows.relay.release, { state: 'missing', repo: 'paritytech/release-automation' });
    const text = renderNodeSummary('previewnet', Object.values(rows));
    assert.match(text, /match \(release missing in paritytech\/release-automation\), report only/);
  });

  it('a drift row whose pinned release is missing shows the missing note', async () => {
    const versions = { [PREV('relay')]: '1.25.1-6ab53982513' };
    const io = fakeIo({ versions, releases: { 'paritytech/release-automation@polkadot-weekly2026w33-rc2': 404 } });
    const rows = byChain(await scanNodes(previewnet(), io));
    assert.equal(rows.relay.verdict, 'drift');
    assert.equal(rows.relay.release.state, 'missing');
    const text = renderNodeSummary('previewnet', Object.values(rows));
    assert.match(text, /pinned release-automation@polkadot-weekly2026w33-rc2 \(release missing in paritytech\/release-automation\), live polkadot-stable2609-1/);
  });

  it('an unreachable GitHub is unverified, never missing, and does not fail the scan', async () => {
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ releaseFail: 'ECONNRESET' })));
    assert.equal(rows.relay.verdict, 'match');
    assert.equal(rows.relay.release.state, 'unverified');
    assert.match(rows.relay.release.detail, /ECONNRESET/);
  });

  it('checks each pinned tag once, with a bounded signal and no retry', async () => {
    const io = fakeIo();
    await scanNodes(previewnet(), io);
    const releaseCalls = io.calls.fetch.filter((c) => c.method === 'GET');
    assert.equal(releaseCalls.length, 1, 'one release check for the one pinned tag');
    assert.ok(releaseCalls[0].signal, 'release check carries an abort signal');
  });
});

// ── mixed slots ──────────────────────────────────────────────────────────────

describe('chains on one slot', () => {
  it('7 and 11 hex of one commit are one commit: no split note', async () => {
    const rows = await scanNodes(previewnet(), fakeIo({ versions: { [PREV('asset-hub')]: '1.24.3-weekly2026w33-253fa81' } }));
    const by = byChain(rows);
    assert.equal(by['asset-hub'].verdict, 'match');
    assert.equal(by.people.verdict, 'match');
    assert.doesNotMatch(renderNodeSummary('previewnet', rows), /chains disagree/);
  });

  it('a genuine disagreement keeps each chain\'s own verdict', async () => {
    const rows = await scanNodes(previewnet(), fakeIo({ versions: { [PREV('people')]: W38_VERSION } }));
    const by = byChain(rows);
    assert.equal(by['asset-hub'].verdict, 'match');
    assert.equal(by.people.verdict, 'drift');
    assert.equal(by.people.attributed, 'polkadot-weekly2026w38-rc1');
    assert.equal(by.relay.verdict, 'match', 'the polkadot slot has one chain, so no split');
  });

  it('commitGroups keeps the most specific sha for a group', () => {
    const groups = commitGroups([
      { slot: 's', commit: '253fa81' },
      { slot: 's', commit: W33 },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].commit, W33);
  });
});

// ── one listing per run, concurrency, deadline ───────────────────────────────

describe('run-level behaviour', () => {
  it('one git ls-remote serves several manifests when they share a loader', async () => {
    const io = fakeIo();
    const loadTags = sdkTagLoader(io);
    for (const network of ['previewnet', 'devnet', 'paseo-next-v2']) {
      const rows = await scanNodes(manifestFor(network), { ...io, loadTags });
      assert.ok(rows.length >= 3, network);
    }
    assert.equal(io.calls.git, 1);
  });

  it('without a shared loader each scan lists the tags again (the CLI must share one)', async () => {
    const io = fakeIo();
    for (const network of ['previewnet', 'devnet']) await scanNodes(manifestFor(network), io);
    assert.equal(io.calls.git, 2);
  });

  it('a failing tag listing throws to the caller', async () => {
    await assert.rejects(scanNodes(previewnet(), fakeIo({ gitFail: 'could not resolve host' })), /could not resolve host/);
  });

  it('runs a network\'s lookups concurrently', async () => {
    const io = fakeIo({ delayMs: 20 });
    await scanNodes(previewnet(), io);
    assert.ok(io.calls.maxInFlight >= 4, `max in flight ${io.calls.maxInFlight}`);
  });

  it('a throwing or unreachable chain does not stop the others', async () => {
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ fail: { [PREV('bulletin')]: 'TypeError: fetch failed' } })));
    assert.equal(rows.bulletin.verdict, 'unreachable');
    assert.match(rows.bulletin.error, /wss:\/\/previewnet\.substrate\.dev\/bulletin: TypeError: fetch failed/);
    assert.equal(rows['web3-storage'].verdict, 'match');
    assert.equal(rows.people.verdict, 'match');
    assert.equal(rows.relay.verdict, 'match');
  });

  it('a failing system_name is tolerated and the name is null', async () => {
    const rows = byChain(await scanNodes(previewnet(), fakeIo({ names: { [PREV('relay')]: 'Parity Polkadot' } })));
    assert.equal(rows.relay.verdict, 'match');
    assert.equal(rows.relay.systemName, 'Parity Polkadot');
    assert.equal(rows['asset-hub'].systemName, null);
  });

  it('gives up on a network after the deadline, and returns normally when lookups finish in time', async () => {
    const hung = fakeIo({ hang: [PREV('relay')] });
    await assert.rejects(scanNodes(previewnet(), { ...hung, deadlineMs: 50 }), /previewnet node scan exceeded/);
    const rows = await scanNodes(previewnet(), { ...fakeIo(), deadlineMs: 5000 });
    assert.equal(rows.length, 6);
  });
});

// ── rendering ────────────────────────────────────────────────────────────────

describe('renderNodeSummary', () => {
  it('is markdown: a header, a blank line, then one "- " bullet per line', async () => {
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet(), fakeIo({ versions: omniOn(W38_VERSION) })));
    const lines = text.split('\n');
    assert.equal(lines[0], 'previewnet nodes (report only, not rewritten, #53):');
    assert.equal(lines[1], '');
    assert.ok(lines.slice(2).length > 0);
    assert.ok(lines.slice(2).every((l) => l.startsWith('- ')), lines.join('\n'));
  });

  it('groups chains per slot and commit, with the example wording', async () => {
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet(), fakeIo({ versions: omniOn(W38_VERSION) })));
    assert.ok(
      text.includes(
        '- polkadot-omni-node (asset-hub, people, bulletin, web3-storage): pinned release-automation@polkadot-weekly2026w33-rc2, live polkadot-weekly2026w38-rc1 (1.24.3-weekly2026w38-eeb597f61b9), report only'
      ),
      text
    );
    assert.ok(text.includes('- polkadot (relay): pinned release-automation@polkadot-weekly2026w33-rc2, live polkadot-weekly2026w33-rc2 (1.24.3-weekly2026w33-253fa818f2b), match, report only'), text);
    assert.ok(text.includes('- eth-rpc: pinned release-automation@polkadot-weekly2026w33-rc2, live polkadot-weekly2026w33-rc2 (eth-rpc/HEAD-253fa81/x86_64-unknown-linux-gnu/rustc1.93.0), match, report only'), text);
  });

  it('words an unreleased commit as in the spec, and never uses the rewritten-pin glyph', async () => {
    const versions = { [PREV('relay')]: '1.24.3-weekly2026w99-abcdef1234' };
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet(), fakeIo({ versions })));
    assert.doesNotMatch(text, /↻/);
    assert.match(text, /live commit abcdef1234 \(1\.24\.3-weekly2026w99-abcdef1234\), no polkadot-sdk tag points at this commit, report only/);
  });

  it('keeps system_name raw', async () => {
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet(), fakeIo({ names: { [PREV('relay')]: 'Parity Polkadot' } })));
    assert.match(text, /; system_name: relay "Parity Polkadot"/);
  });

  it('annotates a genuine split on its own line', async () => {
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet(), fakeIo({ versions: { [PREV('people')]: W38_VERSION } })));
    assert.match(text, /^- polkadot-omni-node: chains disagree on commit: asset-hub, bulletin, web3-storage at 253fa818f2b\S*; people at eeb597f61b9\S*, report only$/m, text);
  });

  it('one line for each unreachable endpoint and each unrecognised version', async () => {
    const text = renderNodeSummary(
      'previewnet',
      await scanNodes(previewnet(), fakeIo({ fail: { [PREV('asset-hub')]: 'timed out' }, versions: { [PREV('people')]: 'polkadot-omni-node 1.0' } }))
    );
    assert.match(text, /^- asset-hub \(polkadot-omni-node\): endpoint unreachable: wss:\/\/previewnet\.substrate\.dev\/asset-hub: timed out, report only$/m);
    assert.match(text, /^- people \(polkadot-omni-node\): unrecognised version "polkadot-omni-node 1\.0", report only$/m);
  });

  it('lists each pinned service the scan does not observe as one not-scanned line', async () => {
    const services = { 'eth-rpc': PINNED, 'storage-provider-node': 'paritytech/web3-storage@v0.4.1-paseo', kubo: 'ipfs/kubo@v0.39.0' };
    const text = renderNodeSummary('previewnet', await scanNodes(previewnet({ services }), fakeIo()));
    assert.match(text, /^- storage-provider-node: pinned paritytech\/web3-storage@v0\.4\.1-paseo, not scanned, report only$/m);
    assert.match(text, /^- kubo: pinned ipfs\/kubo@v0\.39\.0, not scanned, report only$/m);
    assert.equal(text.split('\n').filter((l) => l.includes('not scanned')).length, 2);
    assert.match(text, /^- eth-rpc: pinned/m, 'eth-rpc is still scanned, not listed as not scanned');
  });
});

describe('ETH_RPC_URLS', () => {
  it('maps a URL for every network that pins eth-rpc', () => {
    for (const [network, svcs] of Object.entries(SERVICES)) {
      if (svcs['eth-rpc']) assert.ok(ETH_RPC_URLS[network], `${network} has an eth-rpc URL`);
    }
  });
});

// Regression guard. The CLI imports node-scan.mjs while baseline-scan.mjs is still
// evaluating (top-level await). A static import back into baseline-scan.mjs deadlocks
// that import: the process exits 13 with the runtime scan half printed. The unit tests
// cannot see this, since they never run baseline-scan.mjs as the entry point.
describe('module graph', () => {
  it('node-scan.mjs does not statically import baseline-scan.mjs', () => {
    const src = fs.readFileSync(new URL('./node-scan.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]\.\/baseline-scan\.mjs['"]/);
    assert.doesNotMatch(src, /import\(\s*['"]\.\/baseline-scan\.mjs['"]\s*\)/);
  });
});
