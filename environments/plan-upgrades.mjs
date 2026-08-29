// Decide which chains actually need a runtime upgrade, and why.
//
// Two rules, both about staying close to the network being gated:
//
//   - Only touch what was asked about. A caller supplying builds is asking about
//     those chains; the rest stay as the fork took them from live, which is what
//     the caller's runtime would meet in a real deployment. With nothing supplied
//     the manifest is the ask, so every chain is considered.
//   - Upgrade only on a version change. Same spec_version means the chain already
//     runs this release and there is nothing to install, whatever the bytes say —
//     public Paseo, for one, runs a relay blob that matches no published asset.
//
// Reads the fork's own manifest for what each chain runs, and the blob's
// runtime_version section for what a pin declares.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runtimeSpecOf } from './wasm-spec.mjs';

/**
 * @param plan     [chain, wasm] pairs, in the order they should be applied.
 * @param running  chain -> spec_version the fork is on.
 * @param supplied chains whose runtime arrived as a build.
 * @param specOf   wasm path -> declared spec_version.
 * @returns {{keep: string[], notes: string[], errors: string[]}}
 */
export function planUpgrades({ plan, running, supplied, specOf }) {
  const keep = [];
  const notes = [];
  const errors = [];
  const asked = new Set(supplied);

  for (const [chain, wasm] of plan) {
    const at = running[chain];
    const label = chain.padEnd(14);

    if (asked.size && !asked.has(chain)) {
      notes.push(`  ${label} skip — not supplied, left as the fork took it from live (${at ?? '?'})`);
      continue;
    }

    let offered;
    try {
      offered = specOf(wasm);
    } catch (error) {
      // Undecidable, so hand it to the upgrade itself rather than skipping silently.
      notes.push(`  ${label} upgrade — could not read its spec_version (${error.message})`);
      keep.push([chain, wasm]);
      continue;
    }

    if (at === undefined) {
      notes.push(`  ${label} upgrade — fork manifest does not record this chain, offering ${offered}`);
      keep.push([chain, wasm]);
    } else if (offered === at && asked.has(chain)) {
      // A supplied build that cannot install tests nothing, so it fails rather
      // than skipping: the caller asked about this chain.
      errors.push(
        `${chain}: the supplied build declares spec_version ${offered}, which the chain already runs. ` +
          `The upgrade would install nothing and none of the new code would be tested. ` +
          `Stamp a strictly greater spec_version in the build.`,
      );
    } else if (offered === at) {
      notes.push(`  ${label} skip — already runs ${at}`);
    } else if (offered < at) {
      errors.push(
        `${chain}: the pin is spec_version ${offered} but the chain runs ${at}. That is a downgrade — ` +
          `the manifest is behind what this network deployed, so bump the pin.`,
      );
    } else {
      notes.push(`  ${label} upgrade — ${at} -> ${offered}`);
      keep.push([chain, wasm]);
    }
  }

  return { keep, notes, errors };
}

// CLI: emits the surviving `chain=wasm` lines on stdout, the reasoning on stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planFile, forkManifestFile, candidateManifestFile] = process.argv.slice(2);
  if (!planFile || !forkManifestFile || !candidateManifestFile) {
    console.error('usage: plan-upgrades.mjs <upgrade-plan.env> <fork-manifest.json> <candidate-manifest.json>');
    process.exit(2);
  }

  const fork = JSON.parse(readFileSync(forkManifestFile, 'utf8'));
  const candidate = JSON.parse(readFileSync(candidateManifestFile, 'utf8'));

  const { keep, notes, errors } = planUpgrades({
    plan: readFileSync(planFile, 'utf8')
      .split('\n')
      .map((line) => line.trim().split('='))
      .filter(([chain, wasm]) => chain && wasm),
    running: Object.fromEntries(
      Object.entries(fork.chains ?? {}).map(([chain, c]) => [chain, c.specVersion]),
    ),
    supplied: Object.entries(candidate.chains ?? {})
      .filter(([, c]) => String(c.runtime ?? '').startsWith('file:'))
      .map(([chain]) => chain),
    specOf: (wasm) => runtimeSpecOf(readFileSync(wasm)).specVersion,
  });

  console.error(`Runtime upgrade plan for ${candidate.network}:`);
  for (const note of notes) console.error(note);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length) process.exit(1);
  console.log(keep.map(([chain, wasm]) => `${chain}=${wasm}`).join('\n'));
}
