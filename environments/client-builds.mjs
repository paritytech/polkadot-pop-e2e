#!/usr/bin/env node
// Swaps the product-sdk packages and the truapi release the chain-tests pin for the
// builds a gate run asks for, then prints which versions the run tests.
//
//   PRODUCT_SDK='@parity/product-sdk-individuality@0.10.1-dev.453.0' TRUAPI=0.29.0-rc.1 \
//     node environments/client-builds.mjs
//
// Rewrites package.json files only; the caller reinstalls. A product-sdk package is
// replaced everywhere it is installed, so the SDK packages agree on one copy of it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT_PACKAGE = 'package.json';
const TESTS_PACKAGE = 'packages/chain-tests/package.json';
const LOCKFILE = 'pnpm-lock.yaml';
const TRUAPI = '@parity/truapi';
const SPEC = /^(@parity\/[a-z0-9][a-z0-9-]*)@(.+)$/;

/** `@parity/<package>` → requested version or dist-tag, from a space- or comma-separated list. */
export function parseSpecs(text) {
  const specs = new Map();
  for (const spec of (text ?? '').split(/[\s,]+/).filter(Boolean)) {
    const match = SPEC.exec(spec);
    if (!match) throw new Error(`"${spec}" is not @parity/<package>@<version or dist-tag>`);
    const [, name, wanted] = match;
    if (name === TRUAPI) throw new Error(`${TRUAPI} has a field of its own`);
    if (specs.has(name)) throw new Error(`${name} is named twice`);
    specs.set(name, wanted);
  }
  return specs;
}

/** The version npm resolves `name@wanted` to; fails when npm has none. */
export function publishedVersion(name, wanted) {
  let output;
  try {
    output = execFileSync('npm', ['view', `${name}@${wanted}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (/E404/.test(error.stderr ?? '')) throw new Error(`npm has no ${name}@${wanted}`);
    throw new Error(`failed to look up ${name}@${wanted} on npm: ${error.message}`);
  }
  const version = [output.trim() ? JSON.parse(output) : []].flat().at(-1);
  if (!version) throw new Error(`npm has no ${name}@${wanted}`);
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
      name.startsWith('@parity/')
    )
  );
  for (const [name, version] of productSdk) {
    if (!lockfile.includes(`${name}@`)) throw new Error(`${name} is not installed here, so replacing it tests nothing`);
    nextRoot.pnpm ??= {};
    nextRoot.pnpm.overrides = { ...nextRoot.pnpm.overrides, [name]: version };
    if (nextTests.dependencies?.[name]) nextTests.dependencies[name] = version;
  }
  if (truapi) nextTests.devDependencies[TRUAPI] = truapi;

  const requested = new Map([...productSdk, ...(truapi ? [[TRUAPI, truapi]] : [])]);
  const rows = [...new Set([...pinned.keys(), ...requested.keys()])]
    .sort()
    .map((name) => ({ name, pinned: pinned.get(name) ?? null, tested: requested.get(name) ?? pinned.get(name) }));
  return { root: nextRoot, tests: nextTests, rows };
}

/** The run-summary line naming every client version under test, requested ones marked. */
export function summaryLine(rows) {
  const cells = rows.map(({ name, pinned, tested }) =>
    tested === pinned ? `\`${name}\` ${tested}` : `\`${name}\` **${tested}** (requested, pinned ${pinned ?? 'none'})`
  );
  return `**product-sdk and truapi under test:** ${cells.join(' · ')}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const requested = parseSpecs(process.env.PRODUCT_SDK);
    const productSdk = new Map([...requested].map(([name, wanted]) => [name, publishedVersion(name, wanted)]));
    const truapiWanted = (process.env.TRUAPI ?? '').trim().replace(`${TRUAPI}@`, '');
    const truapi = truapiWanted ? publishedVersion(TRUAPI, truapiWanted) : null;
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = applyBuilds(
      { productSdk, truapi },
      { root: read(ROOT_PACKAGE), tests: read(TESTS_PACKAGE), lockfile: fs.readFileSync(LOCKFILE, 'utf8') }
    );
    if (productSdk.size || truapi) {
      fs.writeFileSync(ROOT_PACKAGE, `${JSON.stringify(next.root, null, 2)}\n`);
      fs.writeFileSync(TESTS_PACKAGE, `${JSON.stringify(next.tests, null, 2)}\n`);
    }
    console.log(summaryLine(next.rows));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
