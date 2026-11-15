// Node and eth-rpc release attribution (#53). REPORT ONLY: nothing here rewrites a pin,
// fails a job or changes an exit code. baseline-scan.mjs prints renderNodeSummary() after
// each manifest's runtime summary and ignores its rows for every decision.
//
// A chain's system_version (system_name is operator-set: shown raw, never used) and
// eth-rpc's web3_clientVersion each name a commit, attributed to the polkadot-sdk tags
// carrying it. The pinned tag's release is checked in the pin's repo, reported apart.
//
// Verdicts: match, drift (`attributed` is the live tag), unreleased (no tag has the commit),
// pin-unknown (repo not allowed for the slot, or no tag), unparsed, unreachable,
// no-endpoint, not-scanned (a pinned service other than eth-rpc, which is not observed).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAINS, NODE_BINARIES, SERVICES, parseReleaseRef } from './release-map.mjs';
import { ghHeaders } from './github.mjs';

// Must not import baseline-scan.mjs: the CLI imports this module while it is still
// evaluating (top-level await), so a static import back deadlocks (exit 13). The CLI
// passes its own rpc() in as io.rpc.

const SDK_REPO_URL = 'https://github.com/paritytech/polkadot-sdk';
const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const DEADLINE_MS = 60_000; // per network, all lookups together

// Public eth-rpc endpoints per network. Only this scan reads them.
export const ETH_RPC_URLS = {
  previewnet: 'https://previewnet.substrate.dev/eth-rpc',
  'paseo-next-v2': 'https://eth-rpc-paseo-next.polkadot.io',
  devnet: 'https://eth-rpc-testnet.polkadot.io',
};

const execFileP = promisify(execFile);

async function runGit(args) {
  const { stdout } = await execFileP('git', args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

// ── parsing: each returns the lowercase commit, or null ─────────────────────

// `<semver>-[<label>-]<commit>`: 1.24.3-weekly2026w38-eeb597f61b9, 1.25.1-6ab53982513.
const NODE_VERSION = /^\d+\.\d+\.\d+(?:-.+?)?-([0-9a-f]{7,40})$/i;

export function parseNodeVersion(str) {
  const m = typeof str === 'string' ? NODE_VERSION.exec(str.trim()) : null;
  return m ? m[1].toLowerCase() : null;
}

// `eth-rpc/<ref>[/<target>/rustc<ver>]`: eth-rpc/HEAD-eeb597f/x86_64-unknown-linux-gnu/rustc1.93.0,
// or a branch build whose ref spans slashes: eth-rpc/mr/eth-rpc-avoid-state-call-fe2ecd3/...
const ETH_VERSION = /^eth-rpc\/(.+?)(?:\/[^/]+\/rustc\S*)?$/;
const REF_COMMIT = /-([0-9a-f]{7,40})$/i;

export function parseEthRpcVersion(str) {
  const m = typeof str === 'string' ? ETH_VERSION.exec(str.trim()) : null;
  const c = m ? REF_COMMIT.exec(m[1]) : null;
  return c ? c[1].toLowerCase() : null;
}

/**
 * `git ls-remote --tags` -> Map(commit sha -> sorted tag names). An annotated tag lists its
 * tag object, then a `^{}` line naming the commit it points at. Only the commit counts.
 */
export function parseLsRemoteTags(text) {
  const commitOf = new Map(); // tag -> sha as listed
  const peeled = new Map(); // tag -> commit named by its ^{} line
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, sha, ref] = m;
    if (ref.endsWith('^{}')) peeled.set(ref.slice(0, -3), sha);
    else commitOf.set(ref, sha);
  }
  for (const [tag, sha] of peeled) commitOf.set(tag, sha);
  const byCommit = new Map();
  for (const [tag, commit] of commitOf) {
    if (!byCommit.has(commit)) byCommit.set(commit, []);
    byCommit.get(commit).push(tag);
  }
  for (const names of byCommit.values()) names.sort();
  return byCommit;
}

/**
 * Memoised polkadot-sdk tag listing: the first call runs one `git ls-remote`, later calls
 * share its promise. The CLI makes one per run and hands it to every manifest's scan.
 */
export function sdkTagLoader(io = {}) {
  const git = io.git ?? runGit;
  let pending = null;
  return () => (pending ??= git(['ls-remote', '--tags', SDK_REPO_URL]).then(parseLsRemoteTags));
}

/**
 * A live commit may be an abbreviation. A prefix that matches one commit resolves to it
 * with that commit's tags. One that matches several keeps the prefix and pools their tags.
 */
export function resolveCommit(tags, prefix) {
  const hits = [...tags].filter(([commit]) => commit.startsWith(prefix));
  if (hits.length === 1) return { commit: hits[0][0], releases: hits[0][1] };
  return { commit: prefix, releases: hits.flatMap(([, names]) => names).sort() };
}

// Tag names to report when several tags name one commit. The pinned tag wins when it is
// among them. Otherwise a final release beats -rcN, stable and weekly beat v-style tags,
// then lexical order.
function rank(tag) {
  const rc = /-rc\d+$/.test(tag) ? 3 : 0;
  if (/^polkadot-(stable|weekly)/.test(tag)) return rc;
  return rc + (/^(polkadot-)?v\d/.test(tag) ? 1 : 2);
}

export function pickTag(candidates, pinnedTag = null) {
  if (candidates.length === 0) return null;
  if (pinnedTag && candidates.includes(pinnedTag)) return pinnedTag;
  return [...candidates].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/**
 * Rows grouped by commit, prefix-aware: 7 and 11 hex of one commit form one group, keyed
 * by its most specific sha.
 */
export function commitGroups(rows) {
  const groups = [];
  for (const r of rows) {
    if (!r.commit) continue;
    const g = groups.find((x) => x.commit.startsWith(r.commit) || r.commit.startsWith(x.commit));
    if (!g) {
      groups.push({ commit: r.commit, rows: [r] });
    } else {
      g.rows.push(r);
      if (r.commit.length > g.commit.length) g.commit = r.commit;
    }
  }
  return groups;
}

// ── pins and releases ───────────────────────────────────────────────────────

/**
 * A pin, resolved. `repo` and `tag` name the pinned release; `commit` is the tag's commit
 * in the polkadot-sdk listing. `reason` says why the pin cannot be compared, else null.
 */
function resolvePin(raw, allowedRepos, tags) {
  const pin = { raw: raw ?? null, repo: null, tag: null, commit: null, reason: null };
  if (!raw) return { ...pin, reason: 'is not pinned' };
  let ref;
  try {
    ref = parseReleaseRef(raw);
  } catch {
    return { ...pin, reason: 'is not a release reference' };
  }
  if (!ref.repo || !ref.tag || ref.tag === 'latest') return { ...pin, reason: 'is not a published tag' };
  Object.assign(pin, { repo: ref.repo, tag: ref.tag });
  if (!allowedRepos.includes(ref.repo)) {
    return { ...pin, reason: `comes from ${ref.repo}, not an allowed source for this slot` };
  }
  for (const [commit, names] of tags) if (names.includes(ref.tag)) pin.commit = commit;
  if (!pin.commit) pin.reason = 'names no polkadot-sdk tag';
  return pin;
}

/**
 * Is the pinned tag published in the pinned repo? One bounded request, never retried. An
 * unreachable GitHub is `unverified`, not `missing`.
 */
async function checkRelease(repo, tag, io) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  try {
    const res = await io.fetch(url, {
      headers: ghHeaders('application/vnd.github+json'),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return { state: 'missing', repo };
    if (!res.ok) return { state: 'unverified', repo, detail: `HTTP ${res.status}` };
    return { state: 'present', repo };
  } catch (err) {
    return { state: 'unverified', repo, detail: err.message };
  }
}

// ── observation ─────────────────────────────────────────────────────────────

/** Read one endpoint's version and parse its commit. A failure becomes the row's verdict. */
async function observe(row, readVersion, parseCommit) {
  try {
    row.version = await readVersion();
    const commit = parseCommit(row.version);
    if (commit) row.commit = commit;
    else row.verdict = 'unparsed';
  } catch (err) {
    row.verdict = 'unreachable';
    row.error = `${row.endpoint}: ${err.message}`;
  }
  return row;
}

async function observeChain(chain, entry, deps) {
  const row = { kind: 'node', name: chain, slot: entry.node, endpoint: entry.ws };
  const [, systemName] = await Promise.all([
    observe(row, () => deps.rpc(entry.ws, 'system_version'), parseNodeVersion),
    deps.rpc(entry.ws, 'system_name').catch(() => null), // informational only
  ]);
  row.systemName = systemName;
  return row;
}

async function observeEthRpc(network, deps) {
  const url = ETH_RPC_URLS[network];
  const row = { kind: 'service', name: 'eth-rpc', slot: 'eth-rpc', endpoint: url };
  if (!url) return { ...row, verdict: 'no-endpoint' };
  return observe(
    row,
    async () => {
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body || typeof body !== 'object') throw new Error('malformed response');
      if (body.error) throw new Error(`web3_clientVersion: ${JSON.stringify(body.error)}`);
      return body.result;
    },
    parseEthRpcVersion
  );
}

/** Rejects with one line if `work` is still running after `ms`. */
function withDeadline(work, ms, network) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${network} node scan exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Scan the chains a manifest lists, plus eth-rpc when it pins it. Lookups run concurrently
 * and each failure is its own row. The scan rejects when the network's deadline passes.
 * The tag listing comes from io.loadTags, so one run makes one `git ls-remote`.
 */
export async function scanNodes(manifest, injected = {}) {
  const deps = { git: runGit, fetch, ...injected };
  if (typeof deps.rpc !== 'function') throw new Error('scanNodes needs io.rpc (baseline-scan.mjs rpc)');
  const known = CHAINS[manifest.network];
  if (!known) throw new Error(`unknown network "${manifest.network}"`);
  const loadTags = injected.loadTags ?? sdkTagLoader(deps);
  return withDeadline(scanRows(manifest, known, deps, loadTags), deps.deadlineMs ?? DEADLINE_MS, manifest.network);
}

async function scanRows(manifest, known, deps, loadTags) {
  const tags = await loadTags();
  const chains = Object.keys(manifest.chains ?? {});
  const slots = [...new Set(chains.filter((c) => known[c]).map((c) => known[c].node))];
  const pins = Object.fromEntries(
    slots.map((slot) => [slot, resolvePin(manifest.binaries?.[slot], NODE_BINARIES[slot]?.repos ?? [], tags)])
  );
  const ethPin = manifest.services?.['eth-rpc']
    ? resolvePin(manifest.services['eth-rpc'], SERVICES[manifest.network]?.['eth-rpc']?.repos ?? [], tags)
    : null;

  const jobs = chains.map((chain) =>
    known[chain]?.ws
      ? observeChain(chain, known[chain], deps)
      : { kind: 'node', name: chain, slot: known[chain]?.node ?? null, verdict: 'no-endpoint' }
  );
  if (ethPin) jobs.push(observeEthRpc(manifest.network, deps));
  const rows = await Promise.all(jobs);

  for (const r of rows) {
    if (!r.commit) continue; // unparsed, unreachable or no-endpoint: the verdict is set
    const pin = r.kind === 'service' ? ethPin : pins[r.slot];
    const { commit, releases } = resolveCommit(tags, r.commit);
    Object.assign(r, { pin, commit });
    if (releases.length === 0) {
      r.verdict = 'unreleased';
    } else if (!pin.commit) {
      r.verdict = 'pin-unknown';
    } else {
      r.verdict = pin.commit.startsWith(commit) ? 'match' : 'drift';
      r.attributed = pickTag(releases, pin.tag);
    }
  }

  // Each resolved pin's release is checked once per pinned tag, whatever the verdict.
  const checks = new Map();
  await Promise.all(
    rows
      .filter((r) => r.pin?.repo && r.pin?.tag)
      .map(async (r) => {
        const key = `${r.pin.repo}@${r.pin.tag}`;
        if (!checks.has(key)) checks.set(key, checkRelease(r.pin.repo, r.pin.tag, deps));
        r.release = await checks.get(key);
      })
  );

  const notScanned = Object.keys(manifest.services ?? {})
    .filter((name) => name !== 'eth-rpc')
    .map((name) => ({ kind: 'service', name, slot: name, verdict: 'not-scanned', raw: manifest.services[name] }));
  return [...rows, ...notScanned];
}

// ── rendering ───────────────────────────────────────────────────────────────

/** `repo@tag` with the repo's short name, as the manifest writes it; the raw pin when unparsed. */
const pinLabel = (pin) => (pin.repo ? `${pin.repo.split('/').pop()}@${pin.tag}` : (pin.raw ?? 'none'));

function releaseNote(release) {
  if (!release || release.state === 'present') return '';
  if (release.state === 'missing') return ` (release missing in ${release.repo})`;
  return ` (release unverified: ${release.detail})`;
}

/** The line for one group of chains that run the same commit. */
function groupLine(group) {
  const first = group.rows[0];
  const who =
    first.kind === 'service' ? first.name : `${first.slot} (${group.rows.map((r) => r.name).join(', ')})`;
  const named = group.rows.filter((r) => r.systemName).map((r) => `${r.name} "${r.systemName}"`);
  const names = named.length ? `; system_name: ${named.join(', ')}` : '';
  const { pin, version, attributed } = first;
  const note = releaseNote(first.release);
  switch (first.verdict) {
    case 'match':
      return `- ${who}: pinned ${pinLabel(pin)}, live ${attributed} (${version}), match${note}, report only${names}`;
    case 'drift':
      return `- ${who}: pinned ${pinLabel(pin)}${note}, live ${attributed} (${version}), report only${names}`;
    case 'unreleased':
      return `- ${who}: pinned ${pinLabel(pin)}${note}, live commit ${group.commit} (${version}), no polkadot-sdk tag points at this commit, report only${names}`;
    case 'pin-unknown':
      return `- ${who}: pin ${pin.raw ?? '(none)'} ${pin.reason}${note}, live ${version}, report only${names}`;
  }
}

/** A row with no commit: one line per chain or service. */
function failureLine(r) {
  const who = r.kind === 'service' ? r.name : `${r.name} (${r.slot})`;
  if (r.verdict === 'not-scanned') return `- ${who}: pinned ${r.raw}, not scanned, report only`;
  if (r.verdict === 'unreachable') return `- ${who}: endpoint unreachable: ${r.error}, report only`;
  if (r.verdict === 'unparsed') return `- ${who}: unrecognised version "${r.version}", report only`;
  return `- ${who}: no scan endpoint mapped, report only`;
}

/**
 * Markdown, so the auto-PR body (scan.out as-is) keeps one bullet per line: rows grouped by
 * slot and live commit, each group's chains on one line, and a note for slots that disagree.
 */
export function renderNodeSummary(network, rows) {
  const out = [`${network} nodes (report only, not rewritten, #53):`, ''];
  for (const slot of new Set(rows.map((r) => r.slot))) {
    const slotRows = rows.filter((r) => r.slot === slot);
    for (const r of slotRows.filter((r) => !r.commit)) out.push(failureLine(r));
    const groups = commitGroups(slotRows);
    for (const g of groups) out.push(groupLine(g));
    if (groups.length > 1) {
      const parts = groups.map((g) => `${g.rows.map((r) => r.name).join(', ')} at ${g.commit}`);
      out.push(`- ${slot}: chains disagree on commit: ${parts.join('; ')}, report only`);
    }
  }
  return out.join('\n');
}
