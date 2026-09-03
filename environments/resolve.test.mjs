// The $GITHUB_ENV contract with the engine: what `overrides` and `repos` emit is read by
// the gate job, not by anything here, so a drift shows up as a spawn failing minutes in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// stderr is captured rather than inherited: resolve.mjs reports refusals there, and a
// test that asserts one should read it instead of printing it.
const args = (...argv) =>
  execFileSync('node', [path.join(HERE, 'resolve.mjs'), ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const refusal = (...argv) => {
  try {
    args(...argv);
  } catch (e) {
    return String(e.stderr);
  }
  return null;
};
const run = (mode, network) => args(mode, path.join(HERE, 'networks', `${network}.json`));
const env = (network) =>
  Object.fromEntries(
    run('overrides', network)
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );

describe('overrides', () => {
  // previewnet used to be the unsuffixed exception here, matching an engine that has
  // since named every network. The gate reads manifest.json out of this directory, so
  // a stale name only surfaces after ensure-deps has already spent its half hour.
  for (const network of ['previewnet', 'paseo-next-v2', 'devnet']) {
    it(`names ${network}'s bundle dir the way the engine does`, () => {
      assert.equal(env(network).FORK_DIR_NAME, `fork-bundle-${network}`);
    });
  }

  it('targets every engine call at the manifest network', () => {
    const e = env('paseo-next-v2');
    assert.equal(e.NETWORK, 'paseo-next-v2');
    assert.equal(e.PPN_NETWORK, 'paseo-next-v2');
  });
});

describe('repos', () => {
  it('preflights the engine checkout, which is no manifest pin', () => {
    assert.match(run('repos', 'previewnet'), /^paritytech\/previewnet-engine$/m);
  });

  it('preflights each repo the manifest actually pulls from', () => {
    const repos = run('repos', 'previewnet').split('\n').filter(Boolean);
    assert.ok(repos.includes('paseo-network/runtimes'), repos.join(' '));
    assert.ok(!repos.includes('paritytech/preview-net-v1'), repos.join(' '));
  });
});

describe('candidates', () => {
  const PREVIEWNET = path.join(HERE, 'networks', 'previewnet.json');
  const head = JSON.parse(fs.readFileSync(PREVIEWNET, 'utf8'));
  // A source this map no longer allows, as an older base branch would still name it.
  const RETIRED = 'paritytech/preview-net-v1@v20260820.184459';
  const baseFile = (over) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pop-base-')), 'base.json');
    fs.writeFileSync(f, JSON.stringify({ ...head, ...over }));
    return f;
  };
  const withRelay = (runtime) => ({ ...head.chains, relay: { runtime } });

  it('reads a base pinning a retired source instead of rejecting it', () => {
    const out = args('candidates', PREVIEWNET, '--base', baseFile({ chains: withRelay(RETIRED) }));
    const [target] = JSON.parse(out);
    assert.equal(target.id, 'target');
    assert.equal(target.manifest.chains.relay.runtime, head.chains.relay.runtime);
  });

  // Reading the base is not the same as being allowed to run its pins: when binaries
  // also move, `binaries-only` splices those pins into a manifest a runner spawns.
  it('still refuses a cross candidate that would run one', () => {
    const base = baseFile({
      chains: withRelay(RETIRED),
      binaries: { ...head.binaries, polkadot: 'paritytech/polkadot-sdk@polkadot-stable2606-1' },
    });
    assert.match(
      refusal('candidates', PREVIEWNET, '--base', base) ?? '',
      /relay runtime must come from paseo-network\/runtimes/
    );
  });
});
