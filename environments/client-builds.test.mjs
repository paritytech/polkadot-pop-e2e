// What a gate run tests when it names product-sdk or truapi builds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyBuilds, parseSpecs, summaryLine } from './client-builds.mjs';

const root = { name: 'pop-e2e', pnpm: { overrides: { '@polkadot-api/json-rpc-provider': '^0.2.0' } } };
const tests = {
  dependencies: { '@parity/product-sdk': '0.43.0', '@parity/product-sdk-individuality': '0.11.5', viem: '^2.57.13' },
  devDependencies: { '@parity/truapi': '0.28.0', vitest: '^5.0.5' },
};
const lockfile = [
  "  '@parity/product-sdk@0.43.0':",
  "  '@parity/product-sdk-descriptors@0.14.0':",
  "  '@parity/product-sdk-individuality@0.11.5':",
].join('\n');

describe('naming product-sdk builds', () => {
  it('takes specs separated by spaces or commas', () => {
    assert.deepEqual(
      [...parseSpecs('@parity/product-sdk@0.39.0-dev.453.0, @parity/product-sdk-individuality@dev')],
      [
        ['@parity/product-sdk', '0.39.0-dev.453.0'],
        ['@parity/product-sdk-individuality', 'dev'],
      ]
    );
  });

  it('rejects anything that is not a versioned @parity package', () => {
    assert.throws(() => parseSpecs('@parity/product-sdk'), /not @parity\/<package>@/);
    assert.throws(() => parseSpecs('viem@2.0.0'), /not @parity\/<package>@/);
  });

  // truapi has its own field because its version also selects the CLI binary.
  it('rejects truapi in the product-sdk list', () => {
    assert.throws(() => parseSpecs('@parity/truapi@0.29.0'), /field of its own/);
  });

  it('rejects a package named twice', () => {
    assert.throws(() => parseSpecs('@parity/product-sdk@1.0.0 @parity/product-sdk@2.0.0'), /named twice/);
  });
});

describe('applying the requested builds', () => {
  it('replaces a package everywhere it is installed, not only where chain-tests names it', () => {
    const next = applyBuilds(
      { productSdk: new Map([['@parity/product-sdk-individuality', '0.10.1-dev.453.0']]), truapi: null },
      { root, tests, lockfile }
    );
    assert.deepEqual(next.root.pnpm.overrides, {
      '@polkadot-api/json-rpc-provider': '^0.2.0',
      '@parity/product-sdk-individuality': '0.10.1-dev.453.0',
    });
    assert.equal(next.tests.dependencies['@parity/product-sdk-individuality'], '0.10.1-dev.453.0');
  });

  // A fix can live in a package the tests only reach through another one.
  it('replaces a package the tests only install through the SDK', () => {
    const next = applyBuilds(
      { productSdk: new Map([['@parity/product-sdk-descriptors', '0.0.0-dev.457.0']]), truapi: null },
      { root, tests, lockfile }
    );
    assert.equal(next.root.pnpm.overrides['@parity/product-sdk-descriptors'], '0.0.0-dev.457.0');
    assert.equal(next.tests.dependencies['@parity/product-sdk-descriptors'], undefined);
  });

  it('rejects a package the workspace never installs', () => {
    assert.throws(
      () => applyBuilds({ productSdk: new Map([['@parity/product-sdk-nft', '1.0.0']]), truapi: null }, { root, tests, lockfile }),
      /not installed here/
    );
  });

  // The truapi-host install and the suite's version check both read this pin.
  it('pins truapi where the CLI install and the suite read it', () => {
    const next = applyBuilds({ productSdk: new Map(), truapi: '0.29.0-rc.1' }, { root, tests, lockfile });
    assert.equal(next.tests.devDependencies['@parity/truapi'], '0.29.0-rc.1');
  });

  it('names every client version under test and marks the requested ones', () => {
    const { rows } = applyBuilds(
      { productSdk: new Map([['@parity/product-sdk-individuality', '0.10.1-dev.453.0']]), truapi: '0.29.0-rc.1' },
      { root, tests, lockfile }
    );
    assert.equal(
      summaryLine(rows),
      '**product-sdk and truapi under test:** `@parity/product-sdk` 0.43.0 · ' +
        '`@parity/product-sdk-individuality` **0.10.1-dev.453.0** (requested, pinned 0.11.5) · ' +
        '`@parity/truapi` **0.29.0-rc.1** (requested, pinned 0.28.0)'
    );
  });
});
