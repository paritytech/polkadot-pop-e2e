// Node and eth-rpc release attribution (#53). REPORT ONLY: nothing here rewrites a
// pin, fails the job or changes an exit code. baseline-scan.mjs prints scanNodes'
// rows after each manifest's runtime summary and ignores them for every decision.
// Docs follow once #87 has merged.
//
// Per chain the scan reads system_version over RPC (system_name is operator-set, so it
// is shown raw and never used). Per eth-rpc, web3_clientVersion over HTTP. The commit
// in each is mapped to the polkadot-sdk tags that carry it: that is source attribution.
// The pin's own repo is then checked for a published release of the pinned tag: that is
// availability, reported separately.
//
// Verdicts per chain or service:
//   match        the live commit is the pinned tag's commit.
//   drift        the live commit belongs to another polkadot-sdk tag (`attributed`).
//   unreleased   no polkadot-sdk tag points at the live commit.
//   pin-unknown  the pin comes from a repo this slot does not allow, or names no tag.
//   unparsed     the version string carries no recognisable commit.
//   unreachable  the endpoint failed.
//   no-endpoint  no scan endpoint is mapped.
// Chains on one slot that report different commits are annotated separately (splitSlots).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHAINS, NODE_BINARIES, SERVICES, parseReleaseRef } from './release-map.mjs';
import { ghHeaders } from './github.mjs';

// This module must not import baseline-scan.mjs. The CLI imports us dynamically while
// it is still evaluating, so a static import back would deadlock and leave the top-level
// await unsettled (exit 13). The CLI passes its own rpc() in as io.rpc instead.

const SDK_REPO_URL = 'https://github.com/paritytech/polkadot-sdk';
const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
export const NODE_SCAN_DEADLINE_MS = 60_000; // per network, all lookups together

// Public eth-rpc endpoints per network. Kept here, not in release-map.mjs, because only
// this scan reads them.
export const ETH_RPC_URLS = {
  previewnet: 'https://previewnet.substrate.dev/eth-rpc',
  'paseo-next-v2': 'https://eth-rpc-paseo-next.polkadot.io',
  devnet: 'https://eth-rpc-testnet.polkadot.io',
};

const execFileP = promisify(execFile);

/** One git call. The default runs the real binary; tests inject their own. */
export async function runGit(args) {
  const { stdout } = await execFileP('git', args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

// ── parsing ──────────────────────────────────────────────────────────────────

// `<semver>-[<label>-]<commit>`: 1.24.3-weekly2026w38-eeb597f61b9, 1.25.1-6ab53982513.
const NODE_VERSION = /^(\d+\.\d+\.\d+)(?:-(.+?))?-([0-9a-f]{7,40})$/i;

export function parseNodeVersion(str) {
  const m = typeof str === 'string' ? NODE_VERSION.exec(str.trim()) : null;
  return m ? { semver: m[1], label: m[2] ?? null, commit: m[3].toLowerCase() } : null;
}

// `eth-rpc/<ref>[/<target>/rustc<ver>]`: eth-rpc/HEAD-eeb597f/x86_64-unknown-linux-gnu/rustc1.93.0,
// or a branch build whose ref spans slashes: eth-rpc/mr/eth-rpc-avoid-state-call-fe2ecd3/...
const ETH_VERSION = /^eth-rpc\/(.+?)(?:\/[^/]+\/rustc\S*)?$/;

export function parseEthRpcVersion(str) {
  const m = typeof str === 'string' ? ETH_VERSION.exec(str.trim()) : null;
  if (!m) return null;
  const c = /-([0-9a-f]{7,40})$/i.exec(m[1]);
  return c ? { ref: m[1], commit: c[1].toLowerCase() } : null;
}

/**
 * `git ls-remote --tags` output -> Map(peeled commit sha -> sorted tag names).
 * An annotated tag has two lines: the plain one names the tag object, the `^{}` one
 * names the commit. Only the commit counts, so the peeled sha wins when both exist.
 */
export function parseLsRemoteTags(text) {
  const direct = new Map(); // tag -> sha as listed (a tag object for annotated tags)
  const peeled = new Map(); // tag -> the commit it points at (the ^{} line)
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(\S+)$/.exec(line.trim());
    if (!m) continue;
    const [, sha, ref] = m;
    if (ref.endsWith('^{}')) peeled.set(ref.slice(0, -3), sha);
    else direct.set(ref, sha);
  }
  const byCommit = new Map();
  for (const tag of new Set([...direct.keys(), ...peeled.keys()])) {
    const commit = peeled.get(tag) ?? direct.get(tag);
    const names = byCommit.get(commit) ?? [];
    names.push(tag);
    byCommit.set(commit, names);
  }
  for (const names of byCommit.values()) names.sort();
  return byCommit;
}

/** One `git ls-remote` of polkadot-sdk. Throws if git or GitHub fails. */
export async function loadSdkTags(io = {}) {
  const git = io.git ?? runGit;
  return parseLsRemoteTags(await git(['ls-remote', '--tags', SDK_REPO_URL]));
}

/**
 * A memoised loader: the first call runs the single `git ls-remote`, later calls get the
 * same promise. The CLI makes one per run and hands it to every manifest's scan.
 */
export function sdkTagLoader(io = {}) {
  let pending = null;
  return () => (pending ??= loadSdkTags(io));
}

/**
 * Tag names whose commit starts with `prefix`. A live commit is an abbreviation, so
 * it is matched by prefix; anything under 7 hex digits is too short to trust.
 */
export function tagsForCommit(tags, prefix) {
  const p = String(prefix).toLowerCase();
  if (p.length < 7) return [];
  const out = new Set();
  for (const [commit, names] of tags) {
    if (commit.startsWith(p)) for (const name of names) out.add(name);
  }
  return [...out].sort();
}

/** The full commit a tag names, or null. */
export function commitForTag(tags, tag) {
  for (const [commit, names] of tags) if (names.includes(tag)) return commit;
  return null;
}

/**
 * The full sha for a commit prefix when the tag map resolves it to exactly one commit,
 * else the prefix unchanged.
 */
export function canonicalCommit(prefix, tags) {
  const p = String(prefix).toLowerCase();
  const hits = [...tags.keys()].filter((c) => c.startsWith(p));
  return hits.length === 1 ? hits[0] : p;
}

/** Two commit strings name the same commit when one is a prefix of the other. */
export const sameCommit = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * Rows grouped by commit identity, prefix-aware: 7 and 11 hex of one commit form one
 * group. A group keeps the most specific sha it has seen.
 */
export function commitGroups(rows) {
  const groups = [];
  for (const r of rows) {
    if (!r.commit) continue;
    const g = groups.find((x) => sameCommit(x.commit, r.commit));
    if (!g) {
      groups.push({ commit: r.commit, rows: [r] });
    } else {
      g.rows.push(r);
      if (r.commit.length > g.commit.length) g.commit = r.commit;
    }
  }
  return groups;
}

/** Slots whose chains report genuinely different commits: Map(slot -> groups). */
export function splitSlots(rows) {
  const split = new Map();
  for (const slot of new Set(rows.map((r) => r.slot))) {
    const groups = commitGroups(rows.filter((r) => r.slot === slot));
    if (groups.length > 1) split.set(slot, groups);
  }
  return split;
}

/**
 * Tag names to report when several tags name the same commit. The pinned tag wins
 * when it is among them. Otherwise: a final release over -rcN, then stable/weekly over
 * the v-style semver tags (`v*` and `polkadot-v*`), then lexical order.
 */
export function pickTag(candidates, pinnedTag = null) {
  if (candidates.length === 0) return null;
  if (pinnedTag && candidates.includes(pinnedTag)) return pinnedTag;
  const rank = (t) => [
    /-rc\d+$/.test(t) ? 1 : 0,
    /^polkadot-(stable|weekly)/.test(t) ? 0 : /^(polkadot-)?v\d/.test(t) ? 1 : 2,
  ];
  return [...candidates].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || (a < b ? -1 : a > b ? 1 : 0);
  })[0];
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * A pin, resolved. `repo` is the pinned repo and `tag` the pinned tag; `commit` is the
 * tag's commit in the polkadot-sdk tag map (source attribution). `reason` says why the
 * pin cannot be compared, and is null when it can.
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
  pin.repo = ref.repo;
  pin.tag = ref.tag;
  if (!allowedRepos.includes(ref.repo)) {
    return { ...pin, reason: `comes from ${ref.repo}, not an allowed source for this slot` };
  }
  pin.commit = commitForTag(tags, ref.tag);
  if (!pin.commit) pin.reason = 'names no polkadot-sdk tag';
  return pin;
}

/** Compare one live commit with its pin. `releases` are the tags carrying the commit. */
function classify(commit, releases, pin) {
  if (releases.length === 0) return { verdict: 'unreleased' };
  if (!pin.commit) return { verdict: 'pin-unknown' };
  const attributed = pickTag(releases, pin.tag);
  return { verdict: pin.commit.startsWith(commit) ? 'match' : 'drift', attributed };
}

/**
 * Is the pinned tag published in the pinned repo? Bounded by a timeout and never
 * retried. An unreachable GitHub is `unverified`, not `missing`.
 */
export async function checkRelease(repo, tag, io) {
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

/** One chain's node: system_version over RPC. Every failure becomes a row, never a throw. */
async function observeChain(chain, entry, deps) {
  const row = { kind: 'node', name: chain, slot: entry.node, endpoint: entry.ws };
  try {
    const [version, systemName] = await Promise.all([
      deps.rpc(entry.ws, 'system_version'),
      deps.rpc(entry.ws, 'system_name').catch(() => null), // informational only
    ]);
    row.version = version;
    row.systemName = systemName;
    const parsed = parseNodeVersion(version);
    if (parsed) row.commit = parsed.commit;
    else row.verdict = 'unparsed';
  } catch (err) {
    row.verdict = 'unreachable';
    row.error = `${entry.ws}: ${err.message}`;
  }
  return row;
}

/** eth-rpc's web3_clientVersion over HTTP POST. Every failure becomes a row. */
async function observeEthRpc(network, deps) {
  const url = ETH_RPC_URLS[network];
  const row = { kind: 'service', name: 'eth-rpc', slot: 'eth-rpc', endpoint: url };
  if (!url) return { ...row, verdict: 'no-endpoint' };
  try {
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
    row.version = body.result;
    const parsed = parseEthRpcVersion(row.version);
    if (parsed) row.commit = parsed.commit;
    else row.verdict = 'unparsed';
  } catch (err) {
    row.verdict = 'unreachable';
    row.error = `${url}: ${err.message}`;
  }
  return row;
}

function withDeadline(work, ms, network) {
  let timer;
  const span = ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${network} node scan exceeded ${span}`)), ms);
  });
  work.catch(() => {}); // a late failure after the deadline must not surface as unhandled
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Scan the chains a manifest pins, plus eth-rpc when it pins that. Lookups run
 * concurrently; each has its own try, so one dead endpoint is one row. The whole scan
 * has a deadline and rejects when it passes (the caller reports one line and moves on).
 * The tag listing is shared through io.loadTags, so one run makes one `git ls-remote`.
 */
export async function scanNodes(manifest, injected = {}) {
  const deps = { git: runGit, fetch: (url, opts) => fetch(url, opts), ...injected };
  if (typeof deps.rpc !== 'function') throw new Error('scanNodes needs io.rpc (baseline-scan.mjs rpc)');
  const known = CHAINS[manifest.network];
  if (!known) throw new Error(`unknown network "${manifest.network}"`);
  const loadTags = injected.loadTags ?? sdkTagLoader(deps);
  return withDeadline(scan(manifest, known, deps, loadTags), deps.deadlineMs ?? NODE_SCAN_DEADLINE_MS, manifest.network);
}

async function scan(manifest, known, deps, loadTags) {
  const tags = await loadTags();
  const chains = Object.keys(manifest.chains ?? {}); // the chains this manifest lists

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
      : Promise.resolve({ kind: 'node', name: chain, slot: known[chain]?.node ?? null, verdict: 'no-endpoint' })
  );
  if (ethPin) jobs.push(observeEthRpc(manifest.network, deps));
  const rows = await Promise.all(jobs);

  for (const r of rows) {
    if (!r.commit) continue; // unparsed, unreachable or no-endpoint: verdict already set
    const pin = r.kind === 'service' ? ethPin : pins[r.slot];
    r.pin = pin;
    r.commit = canonicalCommit(r.commit, tags);
    r.releases = tagsForCommit(tags, r.commit);
    Object.assign(r, classify(r.commit, r.releases, pin));
  }

  // Availability of each matched pin's release, checked once per pinned tag.
  const checks = new Map();
  await Promise.all(
    rows
      .filter((r) => r.verdict === 'match')
      .map(async (r) => {
        const key = `${r.pin.repo}@${r.pin.tag}`;
        if (!checks.has(key)) checks.set(key, checkRelease(r.pin.repo, r.pin.tag, deps));
        r.release = await checks.get(key);
      })
  );
  return rows;
}

// ── rendering ────────────────────────────────────────────────────────────────

/** `repo@tag` with the repo's short name, as the manifest writes it; the raw pin when unparsed. */
const pinLabel = (pin) => (pin.repo ? `${pin.repo.split('/').pop()}@${pin.tag}` : (pin.raw ?? 'none'));

function systemNames(rows) {
  const named = rows.filter((r) => r.systemName);
  return named.length ? `; system_name: ${named.map((r) => `${r.name} "${r.systemName}"`).join(', ')}` : '';
}

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
  const names = systemNames(group.rows);
  const pin = first.pin;
  switch (first.verdict) {
    case 'match':
      return `- ${who}: pinned ${pinLabel(pin)}, live ${first.attributed} (${first.version}), match${releaseNote(first.release)}, report only${names}`;
    case 'drift':
      return `- ${who}: pinned ${pinLabel(pin)}, live ${first.attributed} (${first.version}), report only${names}`;
    case 'unreleased':
      return `- ${who}: pinned ${pinLabel(pin)}, live commit ${group.commit} (${first.version}), no polkadot-sdk tag points at this commit, report only${names}`;
    case 'pin-unknown':
      return `- ${who}: pin ${pin.raw ?? '(none)'} ${pin.reason}, live ${first.version}, report only${names}`;
    default:
      return `- ${who}: ${first.verdict}, report only`;
  }
}

/** A row with no commit: one line per chain or service. */
function failureLine(r) {
  const who = r.kind === 'service' ? r.name : `${r.name} (${r.slot})`;
  if (r.verdict === 'unreachable') return `- ${who}: endpoint unreachable: ${r.error}, report only`;
  if (r.verdict === 'unparsed') return `- ${who}: unrecognised version "${r.version}", report only`;
  return `- ${who}: no scan endpoint mapped, report only`;
}

/**
 * Markdown, so the auto-PR body (scan.out as-is) keeps one bullet per line. Groups rows
 * by slot and live commit, lists each group's chains on one line, and says it is report
 * only. Chains of one slot that report different commits get an extra annotation line.
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
