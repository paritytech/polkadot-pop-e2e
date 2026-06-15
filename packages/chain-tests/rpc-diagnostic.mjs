#!/usr/bin/env node
/**
 * RPC endpoint diagnostic — measures chainHead_follow init failure rate
 * vs legacy chain_getFinalizedHead behavior across endpoints, on N fresh
 * WebSocket connections.
 *
 * Each iteration:
 *   1. Open a fresh WS to the endpoint
 *   2. Call `chainHead_v1_follow` (with-runtime=false) — wait for first event
 *   3. Independently call `chain_getFinalizedHead` (legacy)
 *   4. Record verdicts: chainHead_ok, chainHead_err, legacy_ok, legacy_err
 *   5. Close socket
 *
 * Output a per-endpoint table.
 */

import wsPkg from "ws";
const WebSocket = wsPkg;

const ENDPOINTS = [
  ["paseo-next-v2 People", "wss://paseo-people-next-system-rpc.polkadot.io"],
  ["paseo-next-v2 AH", "wss://paseo-asset-hub-next-rpc.polkadot.io"],
  ["summit People", "wss://summit-people-rpc.polkadot.io"],
  ["summit AH", "wss://summit-asset-hub-rpc.polkadot.io"],
  ["previewnet People", "wss://previewnet.substrate.dev/people"],
  ["previewnet AH", "wss://previewnet.substrate.dev/asset-hub"],
];

const RUNS_PER_ENDPOINT = 20;
const PER_RUN_TIMEOUT_MS = 8000;

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
      } catch (e) {
        clearTimeout(t);
        ws.removeListener("message", onMsg);
        reject(e);
      }
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
    const t = setTimeout(
      () => finish(reject, new Error("chainHead_follow init timeout")),
      deadlineMs,
    );
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
        return; // ignore parse — there are many messages
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
          finish(reject, new Error("chainHead_follow: stop event"));
        }
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "chainHead_v1_follow", params: [false] }));
  });
}

async function probeOnce(url) {
  const result = { chainHeadOk: false, chainHeadErr: null, legacyOk: false, legacyErr: null };
  let ws;
  try {
    ws = await openWs(url);
  } catch (e) {
    result.chainHeadErr = result.legacyErr = `ws-open: ${e.message}`;
    return result;
  }
  try {
    // chainHead_v1_follow + its mandatory `initialized` event, race-free
    // (see followAndAwaitInitialized for why the two-step version was wrong).
    try {
      const { evt } = await followAndAwaitInitialized(ws, PER_RUN_TIMEOUT_MS);
      result.chainHeadOk = !!evt;
    } catch (e) {
      result.chainHeadErr = e.message;
    }
    // legacy chain_getFinalizedHead
    try {
      const hash = await rpcCall(ws, "chain_getFinalizedHead", [], PER_RUN_TIMEOUT_MS);
      result.legacyOk = typeof hash === "string" && hash.startsWith("0x");
    } catch (e) {
      result.legacyErr = e.message;
    }
  } finally {
    try { ws.close(); } catch {}
  }
  return result;
}

(async () => {
  console.log(`# RPC chainHead vs legacy diagnostic — ${RUNS_PER_ENDPOINT} fresh WS per endpoint`);
  console.log(`# ${new Date().toISOString()}`);
  console.log();
  for (const [name, url] of ENDPOINTS) {
    const verdicts = [];
    for (let i = 0; i < RUNS_PER_ENDPOINT; i++) {
      const r = await probeOnce(url);
      verdicts.push(r);
    }
    const chPass = verdicts.filter((v) => v.chainHeadOk).length;
    const lgPass = verdicts.filter((v) => v.legacyOk).length;
    const chErrs = verdicts.filter((v) => !v.chainHeadOk).map((v) => v.chainHeadErr || "").filter(Boolean);
    const lgErrs = verdicts.filter((v) => !v.legacyOk).map((v) => v.legacyErr || "").filter(Boolean);
    const uniqChErr = [...new Set(chErrs)];
    const uniqLgErr = [...new Set(lgErrs)];
    console.log(`## ${name}`);
    console.log(`   ${url}`);
    console.log(`   chainHead_v1_follow init:  ${chPass}/${RUNS_PER_ENDPOINT} ok  (${(100 * chPass / RUNS_PER_ENDPOINT).toFixed(0)}%)`);
    console.log(`   chain_getFinalizedHead:    ${lgPass}/${RUNS_PER_ENDPOINT} ok  (${(100 * lgPass / RUNS_PER_ENDPOINT).toFixed(0)}%)`);
    if (uniqChErr.length) console.log(`   chainHead errors: ${JSON.stringify(uniqChErr)}`);
    if (uniqLgErr.length) console.log(`   legacy   errors: ${JSON.stringify(uniqLgErr)}`);
    console.log();
  }
})();
