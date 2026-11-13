// Decide which chains actually need a runtime upgrade, and why.
//
// Two rules, both about staying close to the network being gated:
//
//   - Only touch what was asked about. A caller supplying builds is asking about
//     those chains; the rest stay as the fork took them from live, which is what
//     the caller's runtime would meet in a real deployment. With nothing supplied
//     the manifest is the ask, so every chain is considered.
//   - A steady-state run asks for nothing, so it upgrades nothing: the fork is
//     tested as it came from live, and pin drift is the baseline scan's to report.
//   - Upgrade only on a version change. Same spec_version means the chain already
//     runs this release and there is nothing to install, whatever the bytes say —
//     public Paseo, for one, runs a relay blob that matches no published asset.
//
// Reads the fork's own manifest for what each chain runs, and the blob's
// runtime_version section for what a pin declares.
//
// A chain the map marks `upgradeAt: 'bite'` passes the same checks, but the bite
// authorizes its runtime and the engine applies it, so it is listed under `enacting`
// with the spec_version to wait for instead of under `keep`.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rpc } from './baseline-scan.mjs';
import { CHAINS } from './release-map.mjs';
import { runtimeSpecOf } from './wasm-spec.mjs';

/**
 * @param plan     [chain, wasm] pairs, in the order they should be applied.
 * @param running  chain -> spec_version the fork is on.
 * @param supplied chains whose runtime arrived as a build.
 * @param specOf   wasm path -> declared spec_version.
 * @param steady   no pin moves in this run.
 * @param bite     chains whose runtime the fork's bite authorized.
 * @returns {{keep: [string, string][], enacting: [string, number][], notes: string[], errors: string[]}}
 */
export function planUpgrades({ plan, running, supplied, specOf, steady = false, bite = [] }) {
  const keep = [];
  const enacting = [];
  const notes = [];
  const errors = [];
  const authorized = new Set(bite);
  const upgrade = (chain, wasm, offered) =>
    authorized.has(chain) ? enacting.push([chain, offered]) : keep.push([chain, wasm]);
  if (steady) {
    for (const [chain] of plan) {
      notes.push(`  ${chain.padEnd(14)} skip — steady state, left as the fork took it from live (${running[chain] ?? '?'})`);
    }
    return { keep, enacting, notes, errors };
  }
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
      if (authorized.has(chain)) {
        errors.push(`${chain}: could not read the spec_version of the runtime the bite authorized (${error.message})`);
        continue;
      }
      // Undecidable, so hand it to the upgrade itself rather than skipping silently.
      notes.push(`  ${label} upgrade — could not read its spec_version (${error.message})`);
      keep.push([chain, wasm]);
      continue;
    }
    const by = authorized.has(chain) ? ', enacted by the engine from the bite' : '';

    if (at === undefined) {
      notes.push(`  ${label} upgrade — fork manifest does not record this chain, offering ${offered}${by}`);
      upgrade(chain, wasm, offered);
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
      notes.push(`  ${label} upgrade — ${at} -> ${offered}${by}`);
      upgrade(chain, wasm, offered);
    }
  }

  return { keep, enacting, notes, errors };
}

const readPlanFile = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter(([chain, wasm]) => chain && wasm);

const suppliedChains = (candidate) =>
  Object.entries(candidate.chains ?? {})
    .filter(([, c]) => String(c.runtime ?? '').startsWith('file:'))
    .map(([chain]) => chain);

const specOf = (wasm) => runtimeSpecOf(readFileSync(wasm)).specVersion;

const biteChainsOf = (network) =>
  Object.entries(CHAINS[network] ?? {})
    .filter(([, wiring]) => wiring.upgradeAt === 'bite')
    .map(([chain]) => chain);

function report(network, notes, errors) {
  console.error(`Runtime upgrade plan for ${network}:`);
  for (const note of notes) console.error(note);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length) process.exit(1);
}

// CLI, two modes, the reasoning on stderr:
//
//   plan-upgrades.mjs --bite <upgrade-plan.env> <candidate-manifest.json>
//     Before the fork: the `chain=wasm` lines the bite authorizes, judged against what
//     live runs now.
//   plan-upgrades.mjs <upgrade-plan.env> <fork-manifest.json> <candidate-manifest.json> <enacting.env>
//     After the fork: the `chain=wasm` lines to upgrade on stdout, and in <enacting.env>
//     the `chain=spec_version` lines the engine enacts from the bite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steady = process.env.STEADY === 'true';

  if (process.argv[2] === '--bite') {
    const [planFile, candidateManifestFile] = process.argv.slice(3);
    if (!planFile || !candidateManifestFile) {
      console.error('usage: plan-upgrades.mjs --bite <upgrade-plan.env> <candidate-manifest.json>');
      process.exit(2);
    }
    const candidate = JSON.parse(readFileSync(candidateManifestFile, 'utf8'));
    const bite = biteChainsOf(candidate.network);
    const plan = readPlanFile(planFile).filter(([chain]) => bite.includes(chain));
    const running = Object.fromEntries(
      await Promise.all(
        plan.map(async ([chain]) => {
          const version = await rpc(CHAINS[candidate.network][chain].ws, 'state_getRuntimeVersion');
          return [chain, version.specVersion];
        }),
      ),
    );
    const { enacting, notes, errors } = planUpgrades({ plan, running, supplied: suppliedChains(candidate), specOf, steady, bite });
    report(candidate.network, notes, errors);
    const authorized = plan.filter(([chain]) => enacting.some(([enactingChain]) => enactingChain === chain));
    console.log(authorized.map(([chain, wasm]) => `${chain}=${wasm}`).join('\n'));
    process.exit(0);
  }

  const [planFile, forkManifestFile, candidateManifestFile, enactingFile] = process.argv.slice(2);
  if (!planFile || !forkManifestFile || !candidateManifestFile || !enactingFile) {
    console.error(
      'usage: plan-upgrades.mjs <upgrade-plan.env> <fork-manifest.json> <candidate-manifest.json> <enacting.env>',
    );
    process.exit(2);
  }

  const fork = JSON.parse(readFileSync(forkManifestFile, 'utf8'));
  const candidate = JSON.parse(readFileSync(candidateManifestFile, 'utf8'));
  const { keep, enacting, notes, errors } = planUpgrades({
    plan: readPlanFile(planFile),
    running: Object.fromEntries(Object.entries(fork.chains ?? {}).map(([chain, c]) => [chain, c.specVersion])),
    supplied: suppliedChains(candidate),
    specOf,
    steady,
    bite: biteChainsOf(candidate.network),
  });
  report(candidate.network, notes, errors);
  console.log(keep.map(([chain, wasm]) => `${chain}=${wasm}`).join('\n'));
  writeFileSync(enactingFile, enacting.map(([chain, spec]) => `${chain}=${spec}\n`).join(''));
}
