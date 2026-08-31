// Picking the right blob out of a caller's artifact, without trusting filenames.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArtifactPins } from './artifact-pins.mjs';

// Deliberately unhelpful names: the point is that they carry no information.
const FILES = {
  'e2e-runtime-wasm': ['/in/e2e-runtime-wasm/a.wasm', '/in/e2e-runtime-wasm/b.wasm'],
};
const SPECS = {
  '/in/e2e-runtime-wasm/a.wasm': { specName: 'next-asset-hub-paseo', compressed: true },
  '/in/e2e-runtime-wasm/b.wasm': { specName: 'next-people-paseo', compressed: true },
};
const io = (over = {}) => ({
  list: (name) => FILES[name] ?? [],
  specOf: (f) => SPECS[f] ?? { specName: null, compressed: false },
  liveSpecName: async (chain) =>
    ({ 'asset-hub': 'next-asset-hub-paseo', people: 'next-people-paseo' })[chain] ?? null,
  ...over,
});
const manifest = () => ({
  network: 'previewnet',
  chains: {
    relay: { runtime: 'paseo-network/runtimes@v2.4.5' },
    'asset-hub': { runtime: 'artifact:e2e-runtime-wasm' },
    people: { runtime: 'artifact:e2e-runtime-wasm' },
  },
});

describe('resolving artifact: pins', () => {
  it('matches each chain by what the blob declares, not its name', async () => {
    const m = manifest();
    await resolveArtifactPins(m, io());
    assert.equal(m.chains['asset-hub'].runtime, 'file:/in/e2e-runtime-wasm/a.wasm');
    assert.equal(m.chains.people.runtime, 'file:/in/e2e-runtime-wasm/b.wasm');
  });

  it('leaves release pins alone', async () => {
    const m = manifest();
    await resolveArtifactPins(m, io());
    assert.equal(m.chains.relay.runtime, 'paseo-network/runtimes@v2.4.5');
  });

  it('prefers the compressed blob when two declare the same runtime', async () => {
    const m = { network: 'previewnet', chains: { people: { runtime: 'artifact:x' } } };
    await resolveArtifactPins(m, io({
      list: () => ['/in/plain.wasm', '/in/small.wasm'],
      specOf: (f) => ({ specName: 'next-people-paseo', compressed: f === '/in/small.wasm' }),
    }));
    assert.equal(m.chains.people.runtime, 'file:/in/small.wasm');
  });

  it('takes a path when one is given outright', async () => {
    const m = { network: 'previewnet', chains: { people: { runtime: 'artifact:x/out/ppl.wasm' } } };
    await resolveArtifactPins(m, io({ list: () => ['/in/out/ppl.wasm'] }));
    assert.equal(m.chains.people.runtime, 'file:/in/out/ppl.wasm');
  });
});

describe('when it cannot tell', () => {
  // The failure today's filename matching had: the chain is quietly left untested.
  it('fails naming what the artifact held and what each blob claimed to be', async () => {
    const m = { network: 'previewnet', chains: { people: { runtime: 'artifact:e2e-runtime-wasm' } } };
    await assert.rejects(
      () => resolveArtifactPins(m, io({
        specOf: () => ({ specName: 'next-coretime-paseo', compressed: true }),
      })),
      /nothing in artifact e2e-runtime-wasm declares spec_name "next-people-paseo".*next-coretime-paseo/s
    );
  });

  it('fails when a named path is not in the artifact', async () => {
    const m = { network: 'previewnet', chains: { people: { runtime: 'artifact:x/nope.wasm' } } };
    await assert.rejects(
      () => resolveArtifactPins(m, io({ list: () => ['/in/other.wasm'] })),
      /names nope\.wasm, which is not in artifact x/
    );
  });

  it('says to name the file when the chain cannot be reached', async () => {
    const m = { network: 'previewnet', chains: { people: { runtime: 'artifact:x' } } };
    await assert.rejects(
      () => resolveArtifactPins(m, io({ liveSpecName: async () => null })),
      /Name the file with artifact:x\/<path>/
    );
  });
});
