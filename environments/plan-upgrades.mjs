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
// runtime_version section for what a pin declares. Emits the surviving
// `chain=wasm` lines on stdout and the reasoning on stderr.

import { readFileSync } from 'node:fs';
import { runtimeSpecOf } from './wasm-spec.mjs';

const [planFile, forkManifestFile, candidateManifestFile] = process.argv.slice(2);
if (!planFile || !forkManifestFile || !candidateManifestFile) {
  console.error('usage: plan-upgrades.mjs <upgrade-plan.env> <fork-manifest.json> <candidate-manifest.json>');
  process.exit(2);
}

const fork = JSON.parse(readFileSync(forkManifestFile, 'utf8'));
const candidate = JSON.parse(readFileSync(candidateManifestFile, 'utf8'));

const supplied = new Set(
  Object.entries(candidate.chains ?? {})
    .filter(([, c]) => String(c.runtime ?? '').startsWith('file:'))
    .map(([chain]) => chain),
);

const plan = readFileSync(planFile, 'utf8')
  .split('\n')
  .map((line) => line.trim().split('='))
  .filter(([chain, wasm]) => chain && wasm);

const keep = [];
let downgrade = false;

console.error(`Runtime upgrade plan for ${candidate.network}:`);
for (const [chain, wasm] of plan) {
  const running = fork.chains?.[chain]?.specVersion;
  const label = chain.padEnd(14);

  if (supplied.size && !supplied.has(chain)) {
    console.error(`  ${label} skip — not supplied, left as the fork took it from live (${running ?? '?'})`);
    continue;
  }

  let offered;
  try {
    offered = runtimeSpecOf(readFileSync(wasm)).specVersion;
  } catch (error) {
    // Undecidable, so hand it to the upgrade itself rather than skipping silently.
    console.error(`  ${label} upgrade — could not read its spec_version (${error.message})`);
    keep.push(`${chain}=${wasm}`);
    continue;
  }

  if (running === undefined) {
    console.error(`  ${label} upgrade — fork manifest does not record this chain, offering ${offered}`);
    keep.push(`${chain}=${wasm}`);
  } else if (offered === running && supplied.has(chain)) {
    // A supplied build that cannot install tests nothing, so it fails rather
    // than skipping: the caller asked about this chain.
    console.error(`::error::${chain}: the supplied build declares spec_version ${offered}, which the chain already runs. The upgrade would install nothing and none of the new code would be tested. Stamp a strictly greater spec_version in the build.`);
    downgrade = true;
  } else if (offered === running) {
    console.error(`  ${label} skip — already runs ${running}`);
  } else if (offered < running) {
    console.error(`::error::${chain}: the pin is spec_version ${offered} but the chain runs ${running}. That is a downgrade — the manifest is behind what this network deployed, so bump the pin.`);
    downgrade = true;
  } else {
    console.error(`  ${label} upgrade — ${running} -> ${offered}`);
    keep.push(`${chain}=${wasm}`);
  }
}

if (downgrade) process.exit(1);
console.log(keep.join('\n'));
