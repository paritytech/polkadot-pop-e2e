// The $GITHUB_ENV contract with the engine: what `overrides` and `repos` emit is read by
// the gate job, not by anything here, so a drift shows up as a spawn failing minutes in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (mode, network) =>
  execFileSync(
    'node',
    [path.join(HERE, 'resolve.mjs'), mode, path.join(HERE, 'networks', `${network}.json`)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
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
