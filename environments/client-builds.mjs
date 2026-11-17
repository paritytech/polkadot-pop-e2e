#!/usr/bin/env node
// Resolves the product-sdk packages and the truapi release a gate run requests to
// exact versions, and swaps them in for the ones the chain-tests pin.
//
//   PRODUCT_SDK='@parity/product-sdk-individuality@dev' TRUAPI=0.29.0-rc.1 \
//     node environments/client-builds.mjs resolve   → product_sdk=… and truapi=… lines
//   PRODUCT_SDK=… TRUAPI=… node environments/client-builds.mjs apply   → run-summary line
//
// `apply` rewrites package.json files only; the caller reinstalls. Each requested
// package, truapi included, is replaced everywhere it is installed, so the truapi-host
// CLI and the truapi library inside product-sdk are the same release.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT_PACKAGE = 'package.json';
const TESTS_PACKAGE = 'packages/chain-tests/package.json';
const LOCKFILE = 'pnpm-lock.yaml';
const TRUAPI = '@parity/truapi';
const SPEC = /^(@parity\/[a-z0-9][a-z0-9-]*)@(.+)$/;
const CLIENT_PACKAGE = /^@parity\/(product-sdk|bulletin-sdk|truapi$)/;

/** `@parity/<package>` → requested version or dist-tag, from a space- or comma-separated list. */
export function parseSpecs(text) {
  const specs = new Map();
  for (const spec of (text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const match = SPEC.exec(spec);
    if (!match) throw new Error(`"${spec}" is not @parity/<package>@<version or dist-tag>`);
    const [, name, requested] = match;
    if (name === TRUAPI) throw new Error(`${TRUAPI} has a field of its own`);
    if (specs.has(name)) throw new Error(`${name} appears twice`);
    specs.set(name, requested);
  }
  return specs;
}

/** The version npm resolves `name@requested` to; fails when npm has none. */
export function publishedVersion(name, requested) {
  let output;
  try {
    output = execFileSync('npm', ['view', `${name}@${requested}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (/E404/.test(error.stderr ?? '')) throw new Error(`npm has no ${name}@${requested}`);
    throw new Error(`failed to look up ${name}@${requested} on npm: ${error.message}`);
  }
  const version = [output.trim() ? JSON.parse(output) : []].flat().at(-1);
  if (!version) throw new Error(`npm has no ${name}@${requested}`);
  return version;
}

/**
 * The package.json files with the requested builds pinned, and one row per @parity
 * package the tests run on. Fails on a product-sdk package the workspace never
 * installs, since replacing it would test nothing.
 */
export function applyBuilds({ productSdk, truapi }, { root, tests, lockfile }) {
  const nextRoot = structuredClone(root);
  const nextTests = structuredClone(tests);
  const pinned = new Map(
    [...Object.entries(tests.dependencies ?? {}), ...Object.entries(tests.devDependencies ?? {})].filter(([name]) =>
      CLIENT_PACKAGE.test(name)
    )
  );
  const requested = new Map([...productSdk, ...(truapi ? [[TRUAPI, truapi]] : [])]);
  for (const [name, version] of requested) {
    if (!lockfile.includes(`${name}@`)) throw new Error(`${name} is not installed here, so replacing it tests nothing`);
    nextRoot.pnpm ??= {};
    nextRoot.pnpm.overrides = { ...nextRoot.pnpm.overrides, [name]: version };
    for (const deps of [nextTests.dependencies, nextTests.devDependencies]) if (deps?.[name]) deps[name] = version;
  }
  const rows = [...new Set([...pinned.keys(), ...requested.keys()])]
    .sort()
    .map((name) => ({ name, pinned: pinned.get(name) ?? null, tested: requested.get(name) ?? pinned.get(name) }));
  return { root: nextRoot, tests: nextTests, rows };
}

/** The run-summary line listing every client version under test, requested ones marked. */
export function summaryLine(rows) {
  const cells = rows.map(({ name, pinned, tested }) =>
    tested === pinned ? `\`${name}\` ${tested}` : `\`${name}\` **${tested}** (requested, pinned ${pinned ?? 'none'})`
  );
  return `**product-sdk and truapi under test:** ${cells.join(' · ')}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  if (mode !== 'resolve' && mode !== 'apply') {
    console.error('usage: node environments/client-builds.mjs <resolve|apply>');
    process.exit(1);
  }
  try {
    const productSdk = new Map(
      [...parseSpecs(process.env.PRODUCT_SDK)].map(([name, requested]) => [name, publishedVersion(name, requested)])
    );
    const truapiRequested = (process.env.TRUAPI ?? '').trim().replace(`${TRUAPI}@`, '');
    const truapi = truapiRequested ? publishedVersion(TRUAPI, truapiRequested) : null;
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = applyBuilds(
      { productSdk, truapi },
      { root: read(ROOT_PACKAGE), tests: read(TESTS_PACKAGE), lockfile: fs.readFileSync(LOCKFILE, 'utf8') }
    );
    if (mode === 'resolve') {
      console.log(`product_sdk=${[...productSdk].map(([name, version]) => `${name}@${version}`).join(' ')}`);
      console.log(`truapi=${truapi ?? ''}`);
    } else {
      if (productSdk.size || truapi) {
        fs.writeFileSync(ROOT_PACKAGE, `${JSON.stringify(next.root, null, 2)}\n`);
        fs.writeFileSync(TESTS_PACKAGE, `${JSON.stringify(next.tests, null, 2)}\n`);
      }
      console.log(summaryLine(next.rows));
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
