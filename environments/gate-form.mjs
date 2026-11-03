#!/usr/bin/env node
// The two human channels into the release gate — the "Release gate request" issue
// form and the Release Gate `workflow_dispatch` form — carry the same ask: a network
// plus a sparse set of pin overrides. FIELDS below is the single list both channels
// render and both parse, so the two can never drift.
//
//   node environments/gate-form.mjs issue < issue-body.md   → {network, target}
//   node environments/gate-form.mjs dispatch                → {target}
//
// `issue` reads the issue-form markdown on stdin and matches on FIELDS[].label;
// `dispatch` reads one GATE_<ID> env var per FIELDS[].id, which the workflow wires
// from its inputs. Both emit the same sparse overlay (or null for a steady-state
// assertion run), so downstream — resolve.mjs, the gate — sees one shape.
//
// One field per override: a requester never has to know the overlay's JSON shape.
// The advanced raw-JSON escape hatch (GATE_ADVANCED / the issue textarea) stays for
// asks the fields cannot express — a different `tests` list, a `ppn_ref` — and
// REPLACES the pin fields when filled.
//
// A pin is `owner/repo@tag`, or `artifact:<name>` for a build uploaded in the
// calling run. One field per chain either way, so what is being tested reads off
// the call: nothing is inferred from filenames. The two client fields are not pins:
// they name the product-sdk packages and truapi release the tests run on, and are
// split out of the overlay before it reaches the manifest.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FIELDS = [
  {
    id: 'binary_polkadot',
    label: 'Node binary: polkadot',
    paths: [['binaries', 'polkadot']],
  },
  {
    id: 'binary_polkadot_omni_node',
    label: 'Node binary: polkadot-omni-node',
    paths: [['binaries', 'polkadot-omni-node']],
  },
  {
    id: 'runtime_relay',
    label: 'Runtime: relay',
    paths: [['chains', 'relay', 'runtime']],
  },
  {
    id: 'runtime_asset_hub',
    label: 'Runtime: asset-hub',
    paths: [['chains', 'asset-hub', 'runtime']],
  },
  {
    id: 'runtime_people',
    label: 'Runtime: people',
    paths: [['chains', 'people', 'runtime']],
  },
  {
    id: 'runtime_bulletin',
    label: 'Runtime: bulletin',
    paths: [['chains', 'bulletin', 'runtime']],
  },
  {
    id: 'runtime_web3_storage',
    label: 'Runtime: web3-storage',
    paths: [['chains', 'web3-storage', 'runtime']],
  },
  {
    id: 'service_eth_rpc',
    label: 'Service: eth-rpc',
    paths: [['services', 'eth-rpc']],
  },
  {
    id: 'service_identity_backend',
    label: 'Service: identity-backend',
    paths: [['services', 'identity-backend']],
  },
  {
    id: 'product_sdk',
    label: 'Client: product-sdk',
    paths: [['product_sdk']],
    client: true,
  },
  {
    id: 'truapi',
    label: 'Client: truapi',
    paths: [['truapi']],
    client: true,
  },
];

export const ADVANCED_LABEL = 'Advanced: raw target overlay (JSON)';

/** Sparse overlay from `{fieldId: pin}`, or null when nothing was filled in. */
export function assemble(values, fields = FIELDS) {
  const target = {};
  for (const { id, paths } of fields) {
    const value = (values[id] ?? '').split('\n')[0].trim();
    if (!value) continue;
    for (const path of paths) {
      let node = target;
      for (const key of path.slice(0, -1)) node = node[key] ??= {};
      node[path[path.length - 1]] = value;
    }
  }
  return Object.keys(target).length ? target : null;
}

/** Unwrap a ```json fence if the raw-JSON field arrived wearing one. */
function parseAdvanced(raw) {
  const fence = /```(?:json)?\n([\s\S]*?)```/.exec(raw);
  const body = fence ? fence[1] : raw;
  try {
    return JSON.parse(body);
  } catch (err) {
    // The dispatch form has no validation pass to comment back with, so say what
    // was wrong with the blob rather than leaving a bare SyntaxError in the log.
    throw new Error(`the advanced target overlay is not valid JSON (${err.message}): ${body.trim()}`);
  }
}

// Issue forms render each field as "### <label>" followed by the value; empty
// optional fields render as "_No response_".
function section(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = body.split(new RegExp(`###\\s*${escaped}\\s*\\n`))[1];
  if (m === undefined) return '';
  const value = m.split(/\n###\s/)[0].trim();
  return value === '_No response_' ? '' : value;
}

/** The raw JSON replaces the pin fields when given; the client fields apply either way. */
function overlay(values, raw) {
  if (!raw) return assemble(values);
  const advanced = parseAdvanced(raw);
  const clients = assemble(values, FIELDS.filter((field) => field.client));
  return clients ? { ...clients, ...advanced } : advanced;
}

export function parseIssueForm(body) {
  const network = section(body, 'Network').split('\n')[0].trim();
  if (!network) throw new Error('the issue names no network');

  const values = {};
  for (const { id, label } of FIELDS) values[id] = section(body, label);
  return { network, target: overlay(values, section(body, ADVANCED_LABEL)) };
}

/** Dispatch inputs arrive as GATE_<ID>; GATE_ADVANCED is the raw-JSON override. */
export function parseDispatchInputs(env) {
  const values = {};
  for (const { id } of FIELDS) values[id] = env[`GATE_${id.toUpperCase()}`] ?? '';
  return { target: overlay(values, (env.GATE_ADVANCED ?? '').trim()) };
}

const RUN_OPTIONS = { ppn_ref: 'ppnRef', product_sdk: 'productSdk', truapi: 'truapi' };

/**
 * Split the keys that are not manifest pins out of an overlay: `ppn_ref` (which
 * previewnet-engine ref the gate runs), `product_sdk` and `truapi` (which client
 * builds the tests run on). Each comes back as a string, empty when not named.
 */
export function splitRunOptions(target) {
  const options = Object.fromEntries(Object.values(RUN_OPTIONS).map((name) => [name, '']));
  if (!target || typeof target !== 'object') return { ...options, target };
  const rest = { ...target };
  for (const [key, name] of Object.entries(RUN_OPTIONS)) {
    if (!(key in rest)) continue;
    options[name] = rest[key] ?? '';
    delete rest[key];
  }
  return { ...options, target: Object.keys(rest).length ? rest : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  if (mode === 'issue') {
    // The issue channel forwards its overlay verbatim into the dispatch form's
    // `advanced` input, so the run options stay inside it — the gate splits them once, below.
    console.log(JSON.stringify(parseIssueForm(fs.readFileSync(0, 'utf8'))));
  } else if (mode === 'dispatch') {
    const { ppnRef, productSdk, truapi, target } = splitRunOptions(parseDispatchInputs(process.env).target);
    console.log(JSON.stringify({ target, ppn_ref: ppnRef, product_sdk: productSdk, truapi }));
  } else {
    console.error('usage: node environments/gate-form.mjs <issue|dispatch>');
    process.exit(1);
  }
}
