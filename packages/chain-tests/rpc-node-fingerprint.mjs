#!/usr/bin/env node
/**
 * RPC node fingerprint diagnostic v2 — identifies which specific upstream
 * nodes behind a load-balanced *.polkadot.io endpoint serve
 * `chainHead_v1_follow` correctly vs fail silently.
 *
 * Two strengthenings vs v1:
 *
 *   1. Per-connection LB stickiness check. Fingerprint the upstream both
 *      BEFORE and AFTER chainHead_follow. If the peer_id differs, the LB
 *      is routing different JSON-RPC methods on the same socket to
 *      different upstreams — which would invalidate fingerprint attribution.
 *      Runs reporting non-sticky are excluded from the per-node table.
 *
 *   2. Larger N per endpoint (default 100 fresh WS) so per-node samples
 *      are big enough to distinguish "this node is broken" (rate ~0%)
 *      from "this node is sometimes-broken" (rate near pool average).
 *
 * Output shape: per-endpoint table of (peer_id, hits, chainHead_ok, rate,
 * 95% CI) so we can read off which nodes are bimodal (~0% or ~100%) vs
 * which sit at the pool average. Plus a `non_sticky` count per endpoint.
 */

import wsPkg from "ws";
const WebSocket = wsPkg;

const ENDPOINTS = [
  ["paseo-next-v2 People", "wss://paseo-people-next-system-rpc.polkadot.io"],
  ["paseo-next-v2 AH", "wss://paseo-asset-hub-next-rpc.polkadot.io"],
  ["summit People", "wss://summit-people-rpc.polkadot.io"],
  ["summit AH", "wss://summit-asset-hub-rpc.polkadot.io"],
];

const RUNS_PER_ENDPOINT = 80;
const PER_RUN_TIMEOUT_MS = 6000;
const CHAINHEAD_INIT_TIMEOUT_MS = 4000;
const PROGRESS_EVERY = 10;

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws-open-timeout"));
    }, PER_RUN_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function rpcCall(ws, method, params, deadlineMs) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const t = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error(`${method} timeout`));
    }, deadlineMs);
    const onMsg = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(t);
          ws.removeListener("message", onMsg);
          if (msg.error) reject(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
      } catch (e) { /* ignore parse errors */ }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

// Subscribe to chainHead_v1_follow AND wait for the mandatory `initialized`
// follow-event, with a SINGLE message listener attached BEFORE the request is
// sent.
//
// Why not the obvious two-step (rpcCall to get the sub id, THEN attach a
// listener for the event)? The server pushes `initialized` in the frame
// immediately after the subscribe response, and `ws` delivers both frames in
// one synchronous batch (same socket read) — firing the message handler twice
// back-to-back with NO microtask drain between them. A two-step probe removes
// its response listener and only re-attaches the event listener on the next
// `await` tick, so `initialized` lands in the gap with no listener attached
// and is lost. That client-side TOCTOU — not any server defect — is what made
// this probe report a bogus ~10–60% "init failure" rate against
// polkadot-parachain while a real client (PAPI, @polkadot/api) reads it at
// 100%. Verified by an independent persistent observer: the server sends
// `initialized` on 100% of connections; only the two-step probe missed it.
//
// One listener, attached up front, buffering the event by subscription id and
// reconciling once the sub id is known, closes the race.
function followAndAwaitInitialized(ws, deadlineMs) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    let subId = null;
    const initializedBySub = new Map(); // sub id -> initialized event
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      ws.removeListener("message", onMsg);
      fn(arg);
    };
    const t = setTimeout(() => finish(reject, new Error("init-timeout")), deadlineMs);
    const tryResolve = () => {
      if (subId != null && initializedBySub.has(subId)) {
        finish(resolve, { subId, evt: initializedBySub.get(subId) });
      }
    };
    const onMsg = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id === id) {
        if (msg.error) {
          finish(reject, new Error(`chainHead_v1_follow: ${msg.error.message || JSON.stringify(msg.error)}`));
          return;
        }
        subId = msg.result;
        tryResolve();
        return;
      }
      if (msg.method === "chainHead_v1_followEvent" && msg.params) {
        const evt = msg.params.result;
        if (evt?.event === "initialized") {
          // Buffer unconditionally — subId may not be assigned yet (the
          // event can arrive in the same batch as the subscribe response).
          initializedBySub.set(msg.params.subscription, evt);
          tryResolve();
        } else if (evt?.event === "stop" && msg.params.subscription === subId) {
          finish(reject, new Error("stop"));
        }
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "chainHead_v1_follow", params: [false] }));
  });
}

async function probeOnce(url) {
  const out = {
    peerIdBefore: null,
    peerIdAfter: null,
    version: null,
    name: null,
    sticky: false,
    chainHeadOk: false,
    error: null,
  };
  let ws;
  try {
    ws = await openWs(url);
  } catch (e) {
    out.error = `ws-open: ${e.message}`;
    return out;
  }
  try {
    out.peerIdBefore = await rpcCall(ws, "system_localPeerId", [], PER_RUN_TIMEOUT_MS).catch((e) => `<err: ${e.message}>`);
    out.version = await rpcCall(ws, "system_version", [], PER_RUN_TIMEOUT_MS).catch((e) => `<err: ${e.message}>`);
    out.name = await rpcCall(ws, "system_name", [], PER_RUN_TIMEOUT_MS).catch((e) => `<err: ${e.message}>`);

    try {
      const { evt } = await followAndAwaitInitialized(ws, CHAINHEAD_INIT_TIMEOUT_MS);
      out.chainHeadOk = !!evt;
    } catch (e) {
      out.error = e.message;
    }

    out.peerIdAfter = await rpcCall(ws, "system_localPeerId", [], PER_RUN_TIMEOUT_MS).catch((e) => `<err: ${e.message}>`);
    out.sticky = (out.peerIdBefore && out.peerIdAfter && out.peerIdBefore === out.peerIdAfter);
  } finally {
    try { ws.close(); } catch {}
  }
  return out;
}

function shortPeer(id) {
  if (typeof id !== "string" || id.length < 16) return String(id);
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

// Wilson 95% CI lower/upper bounds for a binomial proportion. With small n,
// the naive p̂ is a noisy estimate; the CI tells the reader how much to
// trust the per-node rate.
function wilson95(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

async function runEndpoint(name, url) {
  const byPeer = new Map();
  let totalCH = 0, totalRuns = 0, nonSticky = 0, openFails = 0;
  for (let i = 0; i < RUNS_PER_ENDPOINT; i++) {
    const r = await probeOnce(url);
    if (!r.peerIdBefore || (typeof r.peerIdBefore === "string" && r.peerIdBefore.startsWith("<err"))) {
      openFails++;
    } else {
      totalRuns++;
      if (r.chainHeadOk) totalCH++;
      if (!r.sticky) {
        nonSticky++;
      } else {
        const key = r.peerIdBefore;
        if (!byPeer.has(key)) byPeer.set(key, { peerId: key, version: r.version, name: r.name, hits: 0, chOk: 0 });
        const entry = byPeer.get(key);
        entry.hits++;
        if (r.chainHeadOk) entry.chOk++;
      }
    }
    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.error(`[${name}] ${i + 1}/${RUNS_PER_ENDPOINT}  ok=${totalCH}/${totalRuns}  nonsticky=${nonSticky}  peers=${byPeer.size}`);
    }
  }
  return { name, url, byPeer, totalCH, totalRuns, nonSticky, openFails };
}

(async () => {
  console.log(`# Node fingerprint diagnostic v2 — ${RUNS_PER_ENDPOINT} fresh WS per endpoint, parallel across endpoints`);
  console.log(`# ${new Date().toISOString()}`);
  console.log();
  const results = await Promise.all(ENDPOINTS.map(([n, u]) => runEndpoint(n, u)));
  for (const r of results) {
    console.log(`## ${r.name}`);
    console.log(`   ${r.url}`);
    const peers = [...r.byPeer.values()].sort((a, b) => b.hits - a.hits);
    console.log(`   total: ${r.totalCH}/${r.totalRuns} chainHead ok  (${((100 * r.totalCH) / Math.max(1, r.totalRuns)).toFixed(0)}%)`);
    console.log(`   non-sticky (different peer before/after): ${r.nonSticky}/${r.totalRuns}`);
    console.log(`   ws-open failures: ${r.openFails}`);
    console.log(`   unique sticky peer ids observed: ${peers.length}`);
    console.log();
    console.log(`   ${"peer_id".padEnd(16)}  ${"version".padEnd(20)}  hits  ch_ok    rate    95% CI`);
    console.log(`   ${"-".repeat(16)}  ${"-".repeat(20)}  ----  -----  -----   -----------`);
    for (const p of peers) {
      const [lo, hi] = wilson95(p.chOk, p.hits);
      const rate = ((100 * p.chOk) / p.hits).toFixed(0).padStart(4) + "%";
      const ciStr = `[${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}%]`;
      const peerStr = shortPeer(p.peerId).padEnd(16);
      const verStr = (typeof p.version === "string" ? p.version.slice(0, 20) : "?").padEnd(20);
      console.log(`   ${peerStr}  ${verStr}  ${String(p.hits).padStart(4)}  ${String(p.chOk).padStart(5)}  ${rate}   ${ciStr}`);
    }
    console.log();
  }
})();
