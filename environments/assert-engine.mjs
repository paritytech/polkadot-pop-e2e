#!/usr/bin/env node
// Assert the engine agrees with this repo's map and manifest before a gate run:
//
//   node environments/assert-engine.mjs <manifest.json> <show.json>
//
// <show.json> is `ppn show <network> --json`, captured with the SAME overrides the
// run exports (PPN_BINARIES) — it reports what will actually execute. This is the
// no-drift guarantee for the facts we mirror: which binary each chain execs
// (CHAINS.<network>.<chain>.node) is engine wiring we copy for ask-time validation,
// and this step is what makes the copy safe to keep. It also proves every manifest
// pin was applied (marked `overridden`) rather than silently ignored.
//
// Deliberately NOT asserted: the engine's runtime attribution (its runtime files
// feed genesis spawns; a fork's runtimes are converged by our upgrade step) and
// services the engine has no override channel for (identity-backend — delivered by
// replacing files post-fetch, invisible to `show`).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CHAINS, SERVICES, validateManifest } from './release-map.mjs';

export function assertEngineAgrees(manifest, show) {
  const wiring = CHAINS[manifest.network];
  const errors = [];
  const ok = [];
  const shown = new Map((show.chains ?? []).map((c) => [c.key, c]));

  // Iterate the MAP's chains, not the manifest's: a manifest may leave a chain
  // unpinned (devnet's bulletin runs a build no public release carries — the fork
  // keeps it as bitten), but its binary slot and wiring are still ours to check.
  for (const chain of Object.keys(wiring)) {
    const c = shown.get(chain);
    if (!c) {
      errors.push(`engine has no chain "${chain}" — the map names one it does not run`);
      continue;
    }
    const slot = wiring[chain].node;
    if (c.binary?.name !== slot) {
      errors.push(
        `wiring drift: map says ${chain} execs ${slot}, engine says ${c.binary?.name} — update CHAINS in release-map.mjs`
      );
      continue;
    }
    const pin = manifest.binaries[slot];
    const got = `${c.binary.repo}@${c.binary.tag}`;
    if (got !== pin) {
      errors.push(`${chain}: manifest pins ${slot} to ${pin}, engine will run ${got}`);
    } else if (!c.binary.overridden) {
      errors.push(
        `${chain}: engine runs ${got} but not via our override — the pin happens to match its default and would drift silently`
      );
    } else {
      ok.push(`${chain}: ${slot} ${got} (overridden)`);
    }
  }
  for (const key of shown.keys()) {
    if (!wiring[key]) {
      errors.push(`engine runs chain "${key}" the map does not know — add it to CHAINS in release-map.mjs`);
    }
  }

  const flat = new Map((show.binaries ?? []).map((b) => [b.name, b]));
  const services = SERVICES[manifest.network] ?? {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc.override || !manifest.services?.[name]) continue;
    const b = flat.get(svc.override);
    const pin = manifest.services[name];
    if (!b) {
      errors.push(`engine does not fetch a binary named "${svc.override}" (service ${name})`);
    } else if (`${b.repo}@${b.tag}` !== pin) {
      errors.push(`${name}: manifest pins ${pin}, engine will fetch ${b.repo}@${b.tag}`);
    } else {
      ok.push(`${name}: ${pin}`);
    }
  }

  return { ok, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [manifestPath, showPath] = process.argv.slice(2);
  if (!manifestPath || !showPath) {
    console.error('usage: node environments/assert-engine.mjs <manifest.json> <show.json>');
    process.exit(1);
  }
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const show = JSON.parse(fs.readFileSync(showPath, 'utf8'));
  const { ok, errors } = assertEngineAgrees(manifest, show);
  for (const line of ok) console.log(`ok   ${line}`);
  for (const line of errors) console.error(`DRIFT ${line}`);
  if (errors.length) process.exit(1);
  console.log('engine agrees with the map and every pin is applied');
}
