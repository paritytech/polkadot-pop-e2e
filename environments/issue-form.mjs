#!/usr/bin/env node
// Parse a "Release gate request" issue body (GitHub issue-form markdown) into the
// gate's inputs: { network, target } where target is the sparse overlay (or null
// for a steady-state run). One field per override so a requester never has to know
// the overlay's JSON shape; the raw-JSON textarea remains for asks the fields
// cannot express and REPLACES the fields when filled.
//
//   node environments/issue-form.mjs < issue-body.md   → JSON on stdout
//
// Issue forms render each field as "### <label>" followed by the value; empty
// optional fields render as "_No response_".

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const FIELDS = [
  { label: 'Node binary: polkadot', path: ['binaries', 'polkadot'] },
  { label: 'Node binary: polkadot-omni-node', path: ['binaries', 'polkadot-omni-node'] },
  { label: 'Runtime: relay', path: ['chains', 'relay', 'runtime'] },
  { label: 'Runtime: asset-hub', path: ['chains', 'asset-hub', 'runtime'] },
  { label: 'Runtime: people', path: ['chains', 'people', 'runtime'] },
  { label: 'Runtime: bulletin', path: ['chains', 'bulletin', 'runtime'] },
  { label: 'Runtime: web3-storage', path: ['chains', 'web3-storage', 'runtime'] },
  { label: 'Service: eth-rpc', path: ['services', 'eth-rpc'] },
  { label: 'Service: identity-backend', path: ['services', 'identity-backend'] },
];

function section(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = body.split(new RegExp(`###\\s*${escaped}\\s*\\n`))[1];
  if (m === undefined) return '';
  const value = m.split(/\n###\s/)[0].trim();
  return value === '_No response_' ? '' : value;
}

export function parseIssueForm(body) {
  const network = section(body, 'Network').split('\n')[0].trim();
  if (!network) throw new Error('the issue names no network');

  const raw = section(body, 'Advanced: raw target overlay (JSON)');
  if (raw) {
    const fence = /```(?:json)?\n([\s\S]*?)```/.exec(raw);
    return { network, target: JSON.parse(fence ? fence[1] : raw) };
  }

  const target = {};
  for (const { label, path } of FIELDS) {
    const value = section(body, label).split('\n')[0].trim();
    if (!value) continue;
    let node = target;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path[path.length - 1]] = value;
  }
  return { network, target: Object.keys(target).length ? target : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const body = fs.readFileSync(0, 'utf8');
  console.log(JSON.stringify(parseIssueForm(body)));
}
