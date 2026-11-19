// Which polkadot-sdk release the live nodes and eth-rpc run. A chain's system_version and
// eth-rpc's web3_clientVersion each end in a commit, and one `git ls-remote` per run maps
// commits to polkadot-sdk tags. A binary slot whose chains all run one tagged commit the pin
// doesn't name gets that tag as its new pin, from the pinned repo or else another repo the slot
// may come from, when the repo publishes the slot's files under it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getRelease } from './github.mjs';
import { CHAINS, NODE_BINARIES, findAsset, parseReleaseRef } from './release-map.mjs';

const SDK_REPO_URL = 'https://github.com/paritytech/polkadot-sdk';
const DEADLINE_MS = 60_000; // per read

/** The release assets each binary slot is delivered from; polkadot's PVF workers go with it. */
const SLOT_ASSETS = {
  polkadot: ['polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker'],
  'polkadot-omni-node': ['polkadot-omni-node'],
  'polkadot-parachain': ['polkadot-parachain'],
};

export const ETH_RPC_URLS = {
  previewnet: 'https://previewnet.substrate.dev/eth-rpc',
  'paseo-next-v2': 'https://eth-rpc-paseo-next.polkadot.io',
  devnet: 'https://eth-rpc-testnet.polkadot.io',
  westend: 'https://westend-asset-hub-eth-rpc.polkadot.io',
};

// 1.24.3-weekly2026w38-eeb597f61b9, eth-rpc/HEAD-eeb597f/x86_64-unknown-linux-gnu/rustc1.93.0
const COMMIT = /-([0-9a-f]{7,40})(?:\/[^/]+\/rustc\S*)?$/i;

export function parseCommit(version) {
  const match = typeof version === 'string' ? COMMIT.exec(version.trim()) : null;
  return match ? match[1].toLowerCase() : null;
}

/** `git ls-remote --tags` output to Map(commit -> tags). An annotated tag counts by its `^{}` commit. */
export function parseLsRemoteTags(text) {
  const commitOf = new Map();
  for (const [, sha, tag, peeled] of String(text).matchAll(/^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/gm)) {
    if (peeled || !commitOf.has(tag)) commitOf.set(tag, sha);
  }
  const tags = new Map();
  for (const [tag, sha] of commitOf) tags.set(sha, [...(tags.get(sha) ?? []), tag].sort());
  return tags;
}

/** One `git ls-remote` per run, shared by every manifest the CLI scans. */
export function sdkTagLoader(git = (args) => promisify(execFile)('git', args, { timeout: DEADLINE_MS, maxBuffer: 64 << 20 })) {
  let pending;
  return () => (pending ??= git(['ls-remote', '--tags', SDK_REPO_URL]).then(({ stdout }) => parseLsRemoteTags(stdout)));
}

async function ethClientVersion(url, fetchFn) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.result === undefined) throw new Error(`no result: ${JSON.stringify(body?.error ?? body)}`);
  return body.result;
}

/**
 * One line per chain the manifest lists, plus eth-rpc when it is pinned, and one for the pinned
 * services it cannot read; a failed read is its own line. `pins` holds the new pin of each
 * binary slot whose live nodes run a release the pin doesn't name.
 */
export async function scanNodes(manifest, { rpc, loadTags = sdkTagLoader(), fetch: fetchFn = fetch, releaseOf = getRelease }) {
  const known = CHAINS[manifest.network];
  const targets = Object.keys(manifest.chains ?? {}).map((chain) => ({
    name: `${chain} (${known[chain].node})`,
    slot: known[chain].node,
    pin: manifest.binaries?.[known[chain].node],
    read: () => rpc(known[chain].ws, 'system_version'),
  }));
  const ethUrl = ETH_RPC_URLS[manifest.network];
  const services = Object.keys(manifest.services ?? {});
  if (ethUrl && services.includes('eth-rpc')) {
    targets.push({ name: 'eth-rpc', pin: manifest.services['eth-rpc'], read: () => ethClientVersion(ethUrl, fetchFn) });
  }
  const notScanned = services.filter((name) => name !== 'eth-rpc' || !ethUrl);
  const [tags, ...versions] = await Promise.all([loadTags(), ...targets.map((target) => target.read().catch((err) => err))]);
  const rows = targets.map((target, index) => ({ ...target, version: versions[index], live: liveTags(versions[index], tags) }));
  const lines = rows.map(line);
  return {
    lines: notScanned.length ? [...lines, `- not scanned: ${notScanned.join(', ')}`] : lines,
    pins: await slotPins(manifest, rows, releaseOf),
  };
}

/** The polkadot-sdk tags at the version's commit, or null when the version names no commit. */
function liveTags(version, tags) {
  const commit = version instanceof Error ? null : parseCommit(version);
  return commit && [...tags].filter(([sha]) => sha.startsWith(commit)).flatMap(([, names]) => names);
}

function line({ name, pin, version, live }) {
  const pinned = `pinned ${pin ?? 'nothing'}`;
  if (version instanceof Error) return `- ${name}: ${pinned}, unreachable: ${version.message}`;
  if (!live) return `- ${name}: ${pinned}, unrecognised version "${version}"`;
  if (live.length === 0) return `- ${name}: ${pinned}, live ${version}, no polkadot-sdk tag has commit ${parseCommit(version)}`;
  let tag;
  try {
    tag = parseReleaseRef(pin).tag;
  } catch {}
  if (live.includes(tag)) return `- ${name}: ${pinned}, live ${version}, match`;
  return `- ${name}: ${pinned}, live ${live.join(', ')} (${version})`;
}

/**
 * For each pinned slot whose chains all run one tagged commit the pin doesn't name: a release
 * under that tag carrying every file of the slot, from the pinned repo first.
 */
async function slotPins(manifest, rows, releaseOf) {
  const pins = {};
  for (const [slot, pin] of Object.entries(manifest.binaries ?? {})) {
    const { repo, tag: pinnedTag } = parseReleaseRef(pin);
    const lives = rows.filter((row) => row.slot === slot).map((row) => row.live);
    if (!repo || lives.length === 0 || lives.some((live) => !live?.length)) continue;
    const common = lives.reduce((left, right) => left.filter((tag) => right.includes(tag)));
    if (common.includes(pinnedTag)) continue;
    const repos = [repo, ...NODE_BINARIES[slot].repos.filter((other) => other !== repo)];
    const found = await publishedPin(slot, repos, common, releaseOf);
    if (found) pins[slot] = found;
  }
  return pins;
}

async function publishedPin(slot, repos, tags, releaseOf) {
  for (const repo of repos) {
    for (const tag of tags) {
      const release = await releaseOf(repo, tag).catch(() => null);
      if (release && SLOT_ASSETS[slot].every((name) => findAsset(release, name))) return `${repo}@${tag}`;
    }
  }
  return null;
}

export const renderNodeSummary = (network, lines) => [`${network} nodes:`, '', ...lines].join('\n');
