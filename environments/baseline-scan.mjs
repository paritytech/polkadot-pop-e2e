// Baseline scan — keeps environments/networks/*.json true to production.
//
//   node environments/baseline-scan.mjs [--write] [manifest.json ...]
//
// For every chain a manifest pins, the scan reads the LIVE chain's runtime
// (spec version, block, and the raw `:code` bytes) and byte-compares it against
// the pinned release's asset. Three verdicts per chain:
//
//   match         — the record is true; nothing to do.
//   drift         — production moved. The scan walks the chain's allow-listed
//                   repos' recent releases and byte-matches the live `:code`
//                   to an asset; with --write it rewrites the manifest pin.
//                   Attribution is proof (byte equality), never a tag-name guess.
//   unattributed  — production runs bytes NO allow-listed release carries.
//                   Someone deployed unpublished code; the scan exits 1 and
//                   says exactly what it observed (spec, block, hash prefix).
//
// The gate itself never uses these endpoints — its forks get state from the
// engine's bite. The scan exists so the manifests (and the downgrade guard
// that trusts them) stop rotting between human edits. It reads only public
// RPCs and GitHub releases; GITHUB_TOKEN is needed for private pinned repos.

import fs from 'node:fs';
import { CHAINS, runtimePlan, validateManifest } from './release-map.mjs';
import { getRelease, listReleases, downloadAssetBytes } from './github.mjs';
import { runtimeSpecOf } from './wasm-spec.mjs';

const CODE_KEY = '0x3a636f6465'; // ":code"
const RPC_TIMEOUT_MS = 20_000;
const RELEASE_WALK = 15; // newest-first releases per repo the attribution walk inspects

/** One JSON-RPC call over a fresh WebSocket (public endpoints often cap sessions). */
async function rpc(url, method, params = []) {
  const ws = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }));
      ws.onmessage = (m) => {
        clearTimeout(t);
        const body = JSON.parse(m.data);
        body.error ? reject(new Error(`${method}: ${JSON.stringify(body.error)}`)) : resolve(body.result);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error(`${method}: connection failed`));
      };
    });
  } finally {
    ws.close();
  }
}

/** What production runs right now: spec, block (evidence), and the raw :code bytes. */
export async function observeChain(ws) {
  const [version, header, codeHex] = await Promise.all([
    rpc(ws, 'state_getRuntimeVersion'),
    rpc(ws, 'chain_getHeader'),
    rpc(ws, 'state_getStorage', [CODE_KEY]),
  ]);
  return {
    specName: version.specName,
    specVersion: version.specVersion,
    block: parseInt(header.number, 16),
    code: Buffer.from(codeHex.slice(2), 'hex'),
  };
}

/**
 * Attribute a live runtime to a release: walk the chain's allow-listed repos
 * newest-first and compare each release's runtime asset to the live chain.
 * Under 'bytes' the comparison is byte equality with the live :code (the gold
 * standard — proof, not a tag-name guess); under 'spec' it is the RuntimeVersion
 * the artifact declares vs what the chain reports (for upstream-operated chains
 * whose deployed blob byte-matches no published asset). Returns { repo, tag }
 * or null. Injected fetchers keep this testable without the network.
 */
export async function attribute(sources, live, policy = 'bytes', io = { listReleases, downloadAssetBytes }) {
  for (const [repo, assetName] of Object.entries(sources)) {
    const releases = await io.listReleases(repo, RELEASE_WALK);
    for (const release of releases) {
      const asset = (release.assets ?? []).find((a) => a.name === assetName);
      if (!asset) continue;
      if (policy === 'bytes' && asset.size !== live.code.length) continue; // cheap pre-filter, exact check below
      const bytes = await io.downloadAssetBytes(asset);
      if (policy === 'bytes' ? bytes.equals(live.code) : specMatches(bytes, live)) {
        return { repo, tag: release.tag_name };
      }
    }
  }
  return null;
}

function specMatches(artifact, live) {
  try {
    const spec = runtimeSpecOf(artifact);
    return spec.specName === live.specName && spec.specVersion === live.specVersion;
  } catch {
    return false; // an artifact we cannot parse cannot be attributed
  }
}

/** Scan one manifest against production. Returns per-chain verdicts; mutates nothing. */
export async function scanManifest(manifest, io = { observeChain, getRelease, downloadAssetBytes, attribute }) {
  const known = CHAINS[manifest.network];
  const results = [];
  for (const entry of runtimePlan(manifest)) {
    const ws = known[entry.chain].ws;
    if (!ws) {
      results.push({ chain: entry.chain, verdict: 'no-endpoint', pin: `${entry.repo}@${entry.tag}` });
      continue;
    }
    let live;
    try {
      live = await io.observeChain(ws);
    } catch (err) {
      results.push({
        chain: entry.chain,
        verdict: 'unreachable',
        pin: `${entry.repo}@${entry.tag}`,
        error: `${ws}: ${err.message}`,
      });
      continue;
    }
    const policy = known[entry.chain].scanPolicy ?? 'bytes';
    const release = await io.getRelease(entry.repo, entry.tag);
    const asset = (release.assets ?? []).find((a) => a.name === entry.asset);
    const pinned = asset ? await io.downloadAssetBytes(asset) : null;
    const base = {
      chain: entry.chain,
      policy,
      pin: `${entry.repo}@${entry.tag}`,
      observed: { specName: live.specName, specVersion: live.specVersion, block: live.block },
    };
    const pinIsCurrent =
      pinned && (policy === 'bytes' ? pinned.equals(live.code) : specMatches(pinned, live));
    if (pinIsCurrent) {
      results.push({ ...base, verdict: 'match' });
      continue;
    }
    const attributed = await io.attribute(known[entry.chain].runtime, live, policy);
    results.push(
      attributed
        ? { ...base, verdict: 'drift', attributed: `${attributed.repo}@${attributed.tag}` }
        : { ...base, verdict: 'unattributed' }
    );
  }
  return results;
}

/** Rewrite drifted pins in the manifest object. Returns the changed chain names. */
export function applyDrift(manifest, results) {
  const changed = [];
  for (const r of results) {
    if (r.verdict !== 'drift') continue;
    manifest.chains[r.chain].runtime = r.attributed;
    changed.push(r.chain);
  }
  return changed;
}

export function renderSummary(network, results) {
  const mark = { match: '✓', drift: '↻', unattributed: '✗', unreachable: '?', 'no-endpoint': '-' };
  const lines = [`${network}:`];
  for (const r of results) {
    const obs = r.observed ? ` (live: ${r.observed.specName}/${r.observed.specVersion} @ #${r.observed.block})` : '';
    const how = r.policy === 'spec' ? ' [spec]' : '';
    if (r.verdict === 'match') lines.push(`  ${mark.match} ${r.chain}: ${r.pin}${how}${obs}`);
    else if (r.verdict === 'drift') lines.push(`  ${mark.drift} ${r.chain}: ${r.pin} → ${r.attributed}${obs}`);
    else if (r.verdict === 'unattributed')
      lines.push(`  ${mark.unattributed} ${r.chain}: production runs bytes NO allow-listed release carries${obs} — pinned ${r.pin}`);
    else if (r.verdict === 'unreachable') lines.push(`  ${mark.unreachable} ${r.chain}: endpoint unreachable — ${r.error}`);
    else lines.push(`  ${mark['no-endpoint']} ${r.chain}: no scan endpoint mapped (release-map.mjs)`);
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const paths = args.filter((a) => a !== '--write');
  const manifests = paths.length
    ? paths
    : fs
        .readdirSync(new URL('./networks/', import.meta.url))
        .filter((f) => f.endsWith('.json'))
        .map((f) => new URL(`./networks/${f}`, import.meta.url).pathname);

  let sawDrift = false;
  let sawBroken = false;
  for (const p of manifests) {
    const manifest = validateManifest(JSON.parse(fs.readFileSync(p, 'utf8')));
    const results = await scanManifest(manifest);
    console.log(renderSummary(manifest.network, results));
    if (results.some((r) => r.verdict === 'unattributed' || r.verdict === 'unreachable')) sawBroken = true;
    if (results.some((r) => r.verdict === 'drift')) {
      sawDrift = true;
      if (write) {
        const changed = applyDrift(manifest, results);
        fs.writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`  wrote ${p} (${changed.join(', ')})`);
      }
    }
  }
  // Exit contract for the workflow: 0 = record is true (or was just rewritten),
  // 1 = something needs a human (unpublished code on production, dead endpoint).
  // Drift alone is not a failure when --write ran — the auto-PR is the fix.
  if (sawBroken) process.exit(1);
  if (sawDrift && !write) process.exit(2);
}
