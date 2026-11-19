// Which polkadot-sdk release the live nodes and eth-rpc run (#53). Report only: the
// baseline scan prints these lines and never uses them to rewrite a pin or set the exit code.
//
// A chain's system_version and eth-rpc's web3_clientVersion each end in a commit. One
// `git ls-remote` per run maps commits to polkadot-sdk tags, and each line says whether the
// live commit carries the pinned tag.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAINS, parseReleaseRef } from './release-map.mjs';

const SDK_REPO_URL = 'https://github.com/paritytech/polkadot-sdk';
const DEADLINE_MS = 60_000; // per read

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
 * services it cannot read. A failed read is its own line, so the others still report.
 */
export async function scanNodes(manifest, { rpc, loadTags = sdkTagLoader(), fetch: fetchFn = fetch }) {
  const known = CHAINS[manifest.network];
  const targets = Object.keys(manifest.chains ?? {}).map((chain) => ({
    name: `${chain} (${known[chain].node})`,
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
  const lines = targets.map(({ name, pin }, index) => line(name, pin, versions[index], tags));
  return notScanned.length ? [...lines, `- not scanned: ${notScanned.join(', ')}`] : lines;
}

function line(name, pin, version, tags) {
  const pinned = `pinned ${pin ?? 'nothing'}`;
  if (version instanceof Error) return `- ${name}: ${pinned}, unreachable: ${version.message}`;
  const commit = parseCommit(version);
  if (!commit) return `- ${name}: ${pinned}, unrecognised version "${version}"`;
  const live = [...tags].filter(([sha]) => sha.startsWith(commit)).flatMap(([, names]) => names);
  if (live.length === 0) return `- ${name}: ${pinned}, live ${version}, no polkadot-sdk tag has commit ${commit}`;
  let tag;
  try {
    tag = parseReleaseRef(pin).tag;
  } catch {}
  if (live.includes(tag)) return `- ${name}: ${pinned}, live ${version}, match`;
  return `- ${name}: ${pinned}, live ${live.join(', ')} (${version})`;
}

export const renderNodeSummary = (network, lines) => [`${network} nodes (report only):`, '', ...lines].join('\n');
