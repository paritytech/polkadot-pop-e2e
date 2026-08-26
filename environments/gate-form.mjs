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
// asks the fields cannot express — a different `tests` list, splitting asset-hub
// from people, a `ppn_ref` — and REPLACES the fields entirely when filled.
//
// `workflow_dispatch` accepts at most 10 inputs, which is why asset-hub and people
// share one field: they are two runtimes out of one `paritytech/individuality`
// build and have never been pinned apart. Splitting them stays possible via the
// advanced overlay.

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
    id: 'runtime_individuality',
    label: 'Runtime: individuality (asset-hub + people)',
    paths: [
      ['chains', 'asset-hub', 'runtime'],
      ['chains', 'people', 'runtime'],
    ],
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
];

export const ADVANCED_LABEL = 'Advanced: raw target overlay (JSON)';

/** Sparse overlay from `{fieldId: pin}`, or null when nothing was filled in. */
export function assemble(values) {
  const target = {};
  for (const { id, paths } of FIELDS) {
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

export function parseIssueForm(body) {
  const network = section(body, 'Network').split('\n')[0].trim();
  if (!network) throw new Error('the issue names no network');

  const raw = section(body, ADVANCED_LABEL);
  if (raw) return { network, target: parseAdvanced(raw) };

  const values = {};
  for (const { id, label } of FIELDS) values[id] = section(body, label);
  return { network, target: assemble(values) };
}

/** Dispatch inputs arrive as GATE_<ID>; GATE_ADVANCED is the raw-JSON override. */
export function parseDispatchInputs(env) {
  const raw = (env.GATE_ADVANCED ?? '').trim();
  if (raw) return { target: parseAdvanced(raw) };

  const values = {};
  for (const { id } of FIELDS) values[id] = env[`GATE_${id.toUpperCase()}`] ?? '';
  return { target: assemble(values) };
}

/**
 * Split the engine ref out of an overlay. `ppn_ref` is not a manifest pin — it
 * selects which preview-net-v1 the gate runs — but it rides in the advanced JSON
 * because the dispatch form has no tenth slot left for it.
 */
export function splitPpnRef(target) {
  if (!target || typeof target !== 'object' || !('ppn_ref' in target)) {
    return { ppnRef: '', target };
  }
  const { ppn_ref: ppnRef, ...rest } = target;
  return { ppnRef: ppnRef ?? '', target: Object.keys(rest).length ? rest : null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  if (mode === 'issue') {
    // The issue channel forwards its overlay verbatim into the dispatch form's
    // `advanced` input, so ppn_ref stays inside it — the gate splits it once, below.
    console.log(JSON.stringify(parseIssueForm(fs.readFileSync(0, 'utf8'))));
  } else if (mode === 'dispatch') {
    const { ppnRef, target } = splitPpnRef(parseDispatchInputs(process.env).target);
    console.log(JSON.stringify({ target, ppn_ref: ppnRef }));
  } else {
    console.error('usage: node environments/gate-form.mjs <issue|dispatch>');
    process.exit(1);
  }
}
