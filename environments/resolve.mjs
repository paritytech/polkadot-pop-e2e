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
  runtimePlan,
  binaryPlan,
  candidateMatrix,
  mergeTarget,
  allowedSources,
  ppnOverrides,
  envTagPins,
  NETWORK_META,
  SERVICES,
} from './release-map.mjs';

const API = 'https://api.github.com';

function usage(msg) {
  console.error(`${msg}\n\nusage: node environments/resolve.mjs <binaries|runtimes|tests> <manifest.json> [--dir <outDir>]`);
  process.exit(1);
}

function ghHeaders(accept) {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// CI egress drops connections mid-transfer now and then (ECONNRESET); a 4xx is an
// answer, a socket error is not — retry only the latter, briefly.
async function fetchWithRetry(url, opts, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i >= attempts) throw err;
      console.error(`fetch ${url} failed (${err.cause?.code ?? err.message}), retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function getRelease(repo, tag) {
  const url =
    tag === 'latest'
      ? `${API}/repos/${repo}/releases/latest`
      : `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchWithRetry(url, { headers: ghHeaders('application/vnd.github+json') });
  if (res.status === 404) {
    // Fine-grained PATs answer 404 (not 403) for private repos they were never
    // granted — say so, or a correct pin reads like a missing release.
    throw new Error(
      `GET ${url} -> 404. Either the tag does not exist, or ${repo} is private and the token (GITHUB_TOKEN / secrets.GH_PAT) has no read access to it — grant the PAT that repo`
    );
  }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// The asset API endpoint + octet-stream, not browser_download_url: the latter 404s on
// private repos.
async function downloadAsset(asset, dest) {
  const res = await fetchWithRetry(asset.url, {
    headers: ghHeaders('application/octet-stream'),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download ${asset.name} -> ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
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
