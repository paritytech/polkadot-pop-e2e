#!/usr/bin/env node
// Answer "will this token run the gate?" locally, before spending a CI minute.
//
//   GH_PAT=<token> node scripts/check-token.mjs [manifest.json]
//   GH_PAT=$(gh auth token) node scripts/check-token.mjs
//
// Mirrors the release-gate's preflight: it asks the resolver which repos the
// manifest pulls from and probes each one. It also reports what the token IS,
// because the two PAT types fail differently and the fix differs with them.

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';
const token = process.env.GH_PAT ?? process.env.GITHUB_TOKEN;
const manifest = process.argv[2] ?? 'environments/networks/previewnet.json';

if (!token) {
  console.error('set GH_PAT (or GITHUB_TOKEN). Try: GH_PAT=$(gh auth token) node scripts/check-token.mjs');
  process.exit(2);
}

function kindOf(t) {
  if (t.startsWith('github_pat_')) return { kind: 'fine-grained PAT', introspectable: false };
  if (t.startsWith('ghp_')) return { kind: 'classic PAT', introspectable: true };
  if (t.startsWith('gho_')) return { kind: 'OAuth token (the gh CLI\'s own)', introspectable: true };
  if (t.startsWith('ghs_')) return { kind: 'GitHub App installation token', introspectable: false };
  return { kind: 'unrecognised prefix', introspectable: true };
}

const { kind, introspectable } = kindOf(token);
console.log(`token:    ${kind}`);

const head = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}` } });
const login = head.ok ? (await head.json()).login : null;
console.log(`identity: ${login ?? `cannot read /user (HTTP ${head.status})`}`);

if (introspectable) {
  const scopes = head.headers.get('x-oauth-scopes');
  console.log(`scopes:   ${scopes || '(none reported)'}`);
  // A classic PAT against a SAML org is useless until authorised, and the ONLY
  // signal is this header — the token otherwise looks perfectly valid.
  const sso = head.headers.get('x-github-sso');
  if (sso) console.log(`SSO:      ${sso}   <-- authorise it before this token can see org repos`);
} else {
  console.log('scopes:   not introspectable — a fine-grained PAT\'s permissions are');
  console.log('          only visible at github.com/settings/tokens. Probing is the check.');
}

// Which repos this manifest actually needs. Asked of the resolver so it tracks
// pins as they move between private and public (…-community) sources.
const repos = execFileSync('node', ['environments/resolve.mjs', 'repos', manifest], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

console.log(`\nrepos ${manifest} pulls from:`);
let blocked = [];
for (const repo of repos) {
  const authed = await fetch(`${API}/repos/${repo}`, { headers: { Authorization: `Bearer ${token}` } });
  // A repo that answers WITHOUT the token is public and needs no grant at all —
  // worth distinguishing, so nobody widens a token for a repo that never needed it.
  const anon = await fetch(`${API}/repos/${repo}`);
  const visibility = anon.ok ? 'public' : 'private';
  const ok = authed.ok;
  if (!ok) blocked.push(repo);
  console.log(`  ${ok ? 'ok  ' : `${authed.status}`}  ${repo.padEnd(40)} ${visibility}${ok || visibility === 'public' ? '' : '   <-- needs contents:read'}`);
}

if (blocked.length === 0) {
  console.log('\nThis token can run the gate against that manifest.');
} else {
  console.log(`\nBlocked on: ${blocked.join(', ')}`);
  console.log(
    kind === 'fine-grained PAT'
      ? 'Fine-grained: select those repos explicitly under Repository access, with Contents: Read.'
      : 'Classic: needs `repo` scope, then Configure SSO -> Authorize for the org. A token that\n' +
        'skips the SSO step reports 404 (not 403) on private org repos, which reads as "missing".'
  );
  process.exit(1);
}
