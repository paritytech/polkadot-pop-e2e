#!/usr/bin/env node
// Resolve an environment manifest into things the release-gate workflow can execute:
//
//   node environments/resolve.mjs overrides <manifest.json>
//     everything the gate exports to $GITHUB_ENV for this network: PPN_BINARIES
//     (the engine-delivered pins), NETWORK/PPN_NETWORK (which network every engine
//     call targets), FORK_DIR_NAME (the engine's per-network bundle dir),
//     FRESH_BITE (1 when no published bundle exists and the gate bites live), and
//     FORK_IDENTITY_BACKEND=none when the network's fork runs no identity backend
//
//   node environments/resolve.mjs binaries <manifest.json> --dir <engineBinDir>
//     downloads any file-delivered pins into the engine's bin/. Every current pin
//     is engine-delivered (overrides/env tags), so today this validates and
//     downloads nothing — the mode stays for services the engine cannot be told
//     about. Prints "<file>=<path>" lines.
//
//   node environments/resolve.mjs runtimes <manifest.json> [--dir <outDir>]
//     downloads each runtime blob and prints one "<chain>=<path>" line per chain,
//     ready to feed into `make runtime-upgrade`
//
//   node environments/resolve.mjs tests <manifest.json>
//     the manifest's chain-tests scripts, one per line
//
//   node environments/resolve.mjs sources <manifest.json>
//     the allowed release sources per chain/service for the manifest's network —
//     what a tester may put in an overlay; used by the issue-ops rejection comment
//
//   node environments/resolve.mjs candidates <canonical.json> [--base <X.json>] [--target <overlay.json>]
//     the candidate matrix for a gate run, as compact JSON for `fromJSON()` in the
//     workflow. X defaults to the canonical file itself; --base overrides it (the
//     PR flow: X = the file on the base branch, Y = the file at HEAD — the diff IS
//     the ask). --target overlays a sparse ask onto the canonical instead (the
//     dispatch/issue flow: no diff, Y = canonical ⊕ overlay). Neither → a single
//     steady-state assertion run. Both dimensions moved → target plus the two
//     informational cross terms.
//
// "latest" tags resolve to the concrete tag so logs name what was actually gated.
// GITHUB_TOKEN is required for private repos (preview-net-v1). Diagnostics go to
// stderr; stdout is machine-readable only.

import fs from 'node:fs';
import path from 'node:path';
import {
  validateManifest,
  assertNoLocalPins,
  runtimePlan,
  binaryPlan,
  candidateMatrix,
  mergeTarget,
  parseReleaseRef,
  allowedSources,
  ppnOverrides,
  envTagPins,
  NETWORK_META,
  CHAINS,
  SERVICES,
} from './release-map.mjs';
import { getRelease, downloadAssetBytes } from './github.mjs';

function usage(msg) {
  console.error(`${msg}\n\nusage: node environments/resolve.mjs <binaries|runtimes|tests> <manifest.json> [--dir <outDir>]`);
  process.exit(1);
}

async function downloadAsset(asset, dest) {
  const buf = await downloadAssetBytes(asset);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

const [mode, manifestPath, ...rest] = process.argv.slice(2);
if (!mode || !manifestPath) usage('missing arguments');
let outDir = mode === 'binaries' ? null : 'fork-runtimes';
let targetPath = null;
let basePath = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dir') {
    outDir = rest[++i];
    if (!outDir) usage('--dir needs a value');
  } else if (rest[i] === '--target') {
    targetPath = rest[++i];
    if (!targetPath) usage('--target needs a value');
  } else if (rest[i] === '--base') {
    basePath = rest[++i];
    if (!basePath) usage('--base needs a value');
  }
}
if (mode === 'binaries' && !outDir) {
  usage("binaries mode needs --dir <engine bin dir> — it pre-seeds the engine's binaries");
}

const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));

// `file:` pins are refused in a COMMITTED manifest and allowed everywhere else.
// The test is the path: environments/networks/*.json is the durable record of
// what is deployed, and a path cannot be re-fetched or version-compared later
// (see assertNoLocalPins). The gate's own candidate-manifest.json is a merged,
// throwaway file and may carry them — that is the whole point of the feature.
if (/environments[/\\]networks[/\\]/.test(manifestPath)) assertNoLocalPins(manifest);

if (mode === 'binaries') {
  const { plan, recorded } = binaryPlan(manifest);
  for (const c of recorded) {
    console.error(`NOTE: ${c} pin is recorded but not yet deliverable — the engine uses its own default`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Cache releases per repo@tag so the polkadot worker triple costs one API call.
  const releases = new Map();
  for (const entry of plan) {
    const key = `${entry.repo}@${entry.tag}`;
    if (!releases.has(key)) releases.set(key, await getRelease(entry.repo, entry.tag));
    const release = releases.get(key);
    const asset = (release.assets ?? []).find((a) => a.name === entry.asset);
    if (!asset) {
      throw new Error(
        `${entry.repo}@${release.tag_name} does not carry ${entry.asset} (needed for ${entry.component})`
      );
    }
    const dest = path.join(outDir, entry.file);
    const bytes = await downloadAsset(asset, dest);
    fs.chmodSync(dest, 0o755);
    console.error(`fetched ${entry.asset} (${entry.repo}@${release.tag_name}) -> ${dest}, ${bytes} bytes`);
    console.log(`${entry.file}=${dest}`);
  }
} else if (mode === 'tests') {
  for (const t of manifest.tests) console.log(t);
} else if (mode === 'repos') {
  // Every GitHub repo this manifest's pins are fetched from, plus the engine —
  // what a token must be able to read for THIS run. Emitted so the gate can
  // preflight exactly what it needs rather than a hardcoded list that drifts as
  // manifests move between private and public (…-community) sources.
  const repos = new Set(['paritytech/preview-net-v1']);
  for (const pin of [
    ...Object.values(manifest.binaries ?? {}),
    ...Object.values(manifest.services ?? {}),
    ...Object.values(manifest.chains ?? {}).map((c) => c.runtime),
  ]) {
    if (typeof pin !== 'string') continue;
    const ref = parseReleaseRef(pin);
    if (!ref.local) repos.add(ref.repo); // a local file needs no token
  }
  for (const r of [...repos].sort()) console.log(r);
} else if (mode === 'sources') {
  console.log(allowedSources(manifest.network));
} else if (mode === 'meta') {
  const meta = NETWORK_META[manifest.network] ?? {};
  console.log(JSON.stringify({ network: manifest.network, ...meta }));
} else if (mode === 'overrides') {
  const net = manifest.network;
  console.log(`NETWORK=${net}`);
  console.log(`PPN_NETWORK=${net}`);
  console.log(`FORK_DIR_NAME=fork-bundle${net === 'previewnet' ? '' : `-${net}`}`);
  console.log(`FRESH_BITE=${NETWORK_META[net]?.freshBite ? 1 : 0}`);
  console.log(`FORK_WAIT_SECONDS=${NETWORK_META[net]?.waitSeconds ?? 900}`);
  // Whether the fork RUNS an identity backend is engine wiring (SERVICES), not a
  // manifest pin — the canonical deliberately omits identity-backend so the engine's
  // own default tag governs; only a candidate override exports DUB_TAG.
  if (!SERVICES[net]?.['identity-backend']) console.log('FORK_IDENTITY_BACKEND=none');
  for (const [envVar, tag] of Object.entries(envTagPins(manifest))) console.log(`${envVar}=${tag}`);
  console.log(`PPN_BINARIES=${ppnOverrides(manifest)}`);
} else if (mode === 'candidates') {
  if (basePath && targetPath) usage('--base and --target are alternative flows, pass one');
  const base = basePath
    ? validateManifest(JSON.parse(fs.readFileSync(basePath, 'utf8')))
    : manifest;
  const target = targetPath ? JSON.parse(fs.readFileSync(targetPath, 'utf8')) : null;
  const effective = target ? validateManifest(mergeTarget(manifest, target)) : manifest;
  const matrix = candidateMatrix(base, effective);
  for (const c of matrix) {
    console.error(`  ${c.id} (gating=${c.gating}): ${c.purpose}`);
    for (const t of c.transitions) console.error(`      ${t}`);
  }
  console.log(JSON.stringify(matrix));
} else if (mode === 'runtimes') {
  const plan = runtimePlan(manifest);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of plan) {
    if (entry.local) {
      if (!fs.existsSync(entry.file)) {
        throw new Error(`${entry.chain} pins file:${entry.file}, which does not exist`);
      }
      // Copied rather than referenced so every chain's wasm sits in one directory
      // under the name the converge step expects, local or downloaded alike.
      const dest = path.join(outDir, `${entry.chain}.wasm`);
      fs.copyFileSync(entry.file, dest);
      console.error(`local ${entry.file} -> ${dest}, ${fs.statSync(dest).size} bytes`);
      console.log(`${entry.chain}=${dest}`);
      continue;
    }
    if (entry.artifact) {
      throw new Error(
        `${entry.chain} still pins artifact:${entry.artifact} — the gate resolves those to ` +
          `files before this step (environments/artifact-pins.mjs). Reaching here means the ` +
          `download step did not run.`
      );
    }
    const release = await getRelease(entry.repo, entry.tag);
    const asset = (release.assets ?? []).find((a) => a.name === entry.asset);
    if (!asset) {
      throw new Error(
        `${entry.repo}@${release.tag_name} does not carry ${entry.asset} (needed for ${entry.chain})`
      );
    }
    const dest = path.join(outDir, `${entry.chain}.wasm`);
    const bytes = await downloadAsset(asset, dest);
    console.error(`fetched ${entry.asset} (${entry.repo}@${release.tag_name}) -> ${dest}, ${bytes} bytes`);
    console.log(`${entry.chain}=${dest}`);
  }
} else {
  usage(`unknown mode "${mode}"`);
}
