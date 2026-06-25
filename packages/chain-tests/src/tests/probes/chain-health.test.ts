/**
 * First-line liveness probe for every chain in the suite. Runs ahead of
 * IB-health and every feature suite (see `package.json` test script
 * ordering) so an unhealthy chain surfaces at the top of the report
 * rather than being inferred from a 6-min PGAS hang.
 *
 * For each chain we record the verdict in `chain-cascade`; downstream
 * suites' beforeAlls call `assertChainHealthy(...)` and fail-fast off
 * the cached marker, so a dead or stalled chain surfaces here once
 * rather than as a 6-min hang in every feature suite.
 *
 * Scope is deliberately narrow: block production / finality liveness
 * only. Ring-specific health — AH ring-root mirror catch-up, stale
 * rings, build latency — is owned by the Ring Health probe
 * (probes/ring-health.test.ts) and must NOT be duplicated here. That
 * probe also seeds the same `chain-cascade` / `ring-cascade` markers, so
 * the AH-ring-roots fail-fast that used to live in this file (added for
 * the 2026-06-03 paseo-next-v2 incident — AH producing blocks but its
 * `MembersSubscriber.RingRoots` window lagging, hanging PGAS's
 * `waitForAssetHubRing`) is preserved there, not lost.
 *
 * The probe deliberately does cheap checks only — no signed extrinsics,
 * no funded operations — so a 10-second probe failure means the chain
 * is genuinely broken, not "your test account is misconfigured".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import {
  createPeopleClient,
  createAssetHubClient,
  createBulletinClient,
  type PeopleApi,
  type AssetHubApi,
  type BulletinApi,
} from "../../lib/client.js";
import { markChainUnhealthy, type ChainName } from "../../lib/chain-cascade.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";

// Per-test timeout. Covers the fast path (one RPC roundtrip, ~hundreds
// of ms on a healthy chain) AND the slow path that waits one
// ADVANCEMENT_WINDOW_MS to disambiguate "stale finality" from "chain
// stalled" — see probeChainProducing() below. Must exceed the
// advancement window plus a couple of RPC roundtrips.
const FINALIZED_BLOCK_PROBE_MS = 60_000;

// When the fast path trips on stale finality, wait this long and
// re-read finalized block. If the number advanced, the chain is
// provably producing and the prior staleness was a normal finality
// batch — pass. If no advancement, this is a real stall.
//
// MUST exceed one relay-finality round. GRANDPA finalizes these
// parachains in bursts ~every 13s (relay finality cadence), NOT once
// per authored block — so a window shorter than that can legitimately
// catch zero advancement on a perfectly healthy chain and false-fail.
// 30s spans ~2 finality rounds, well clear of the jitter.
const ADVANCEMENT_WINDOW_MS = 30_000;

// Per-chain block authoring cadence. People + AssetHub run at ~2s/block
// (relay-driven async backing on parachains using the AH runtime),
// Bulletin at ~6s/block. The freshness budgets below are derived from
// these so they stay correct if/when chain cadence changes — and so a
// slow Bulletin doesn't get the same absolute slack as the faster chains
// just because they share a probe.
const PEOPLE_BLOCK_SECONDS = 2;
const AH_BLOCK_SECONDS = 2;
const BULLETIN_BLOCK_SECONDS = 6;

// "Latest finalized block is stale" budget per chain. Only consulted on
// the slow path (after a no-advancement sample). Healthy parachains can
// run 30-60s behind finality during normal operation (GRANDPA rounds,
// relay-chain backing); these budgets are deliberately generous so the
// advancement check is the gating signal, not absolute age. People + AH
// share the 60-block multiplier because their 2s cadence makes
// finality-age straddle the operating range — see 2026-06-11 false-fail
// incident; a 30-block (60s) budget at 2s would re-introduce it.
const MAX_PEOPLE_BLOCKS_STALE = 60;
const MAX_AH_BLOCKS_STALE = 60;
const MAX_BULLETIN_BLOCKS_STALE = 30;
const MAX_PEOPLE_FRESHNESS_MS = PEOPLE_BLOCK_SECONDS * MAX_PEOPLE_BLOCKS_STALE * 1000;
const MAX_AH_FRESHNESS_MS = AH_BLOCK_SECONDS * MAX_AH_BLOCKS_STALE * 1000;
const MAX_BULLETIN_FRESHNESS_MS = BULLETIN_BLOCK_SECONDS * MAX_BULLETIN_BLOCKS_STALE * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Confirm the chain is producing finalized blocks.
 *
 * Two-sample design: a single freshness check trips on normal
 * finality jitter (parachains can sit 30-60s behind finality during
 * routine operation). We instead ask the much stricter question
 * "did the finalized head advance in a short window?" — that answer
 * is unambiguous even when the absolute age is high.
 *
 * Fast path: one RPC + one timestamp lookup. If finalized-age is
 * inside the per-chain budget, return immediately.
 *
 * Slow path: take a second sample after ADVANCEMENT_WINDOW_MS.
 * Advancement of any size = healthy. Zero advancement *and* still
 * over budget = real stall → mark unhealthy and throw.
 */
async function probeChainProducing(opts: {
  chain: ChainName;
  label: string;
  blockSeconds: number;
  freshnessBudgetMs: number;
  maxBlocksStale: number;
  client: PolkadotClient;
  getTimestampAt: (hash: `0x${string}`) => Promise<number>;
}): Promise<void> {
  const { chain, label, blockSeconds, freshnessBudgetMs, maxBlocksStale, client, getTimestampAt } =
    opts;
  const budgetS = freshnessBudgetMs / 1000;

  const sampleA = await client.getFinalizedBlock();
  expect(sampleA.number).toBeGreaterThan(0);
  const tsA = await getTimestampAt(sampleA.hash as `0x${string}`);
  const ageAms = Date.now() - tsA;

  if (ageAms <= freshnessBudgetMs) {
    console.log(
      `[chain-health] ${label} finalized #${sampleA.number} (${sampleA.hash.slice(0, 10)}…) age=${(ageAms / 1000).toFixed(1)}s (budget ${budgetS}s @ ${blockSeconds}s/block)`,
    );
    return;
  }

  console.log(
    `[chain-health] ${label} finalized #${sampleA.number} age=${(ageAms / 1000).toFixed(1)}s exceeds ${budgetS}s budget; sampling for advancement over ${ADVANCEMENT_WINDOW_MS / 1000}s…`,
  );
  await sleep(ADVANCEMENT_WINDOW_MS);
  const sampleB = await client.getFinalizedBlock();
  const advanced = sampleB.number - sampleA.number;
  if (advanced > 0) {
    console.log(
      `[chain-health] ${label} advanced ${advanced} block(s) in ${ADVANCEMENT_WINDOW_MS / 1000}s (#${sampleA.number} → #${sampleB.number}); chain is producing despite stale finality age.`,
    );
    return;
  }

  const tsB = await getTimestampAt(sampleB.hash as `0x${string}`);
  const ageBs = (Date.now() - tsB) / 1000;
  const msg =
    `${label} latest finalized block did not advance over ${ADVANCEMENT_WINDOW_MS / 1000}s ` +
    `AND is ${ageBs.toFixed(0)}s stale (>${budgetS}s budget; ${maxBlocksStale} blocks at ${blockSeconds}s/block). ` +
    `RPC responds but the chain is not producing finalized blocks.`;
  markChainUnhealthy(chain, msg);
  throw new Error(msg);
}

describe("Chain Health", () => {
  let network: NetworkConfig;
  let peopleClient: PolkadotClient;
  let peopleApi: PeopleApi;
  let assetHubClient: PolkadotClient;
  let assetHubApi: AssetHubApi;
  let bulletinClient: PolkadotClient;
  let bulletinApi: BulletinApi;

  beforeAll(() => {
    network = getNetworkConfig();
    console.log(`[chain-health] Network: ${network.name}`);
    console.log(`[chain-health] People: ${network.people.ws}`);
    console.log(`[chain-health] Asset Hub: ${network.assetHub.ws}`);
    console.log(`[chain-health] Bulletin: ${network.bulletin.ws}`);

    const people = createPeopleClient(network.people.ws);
    peopleClient = people.client;
    peopleApi = people.api;

    const ah = createAssetHubClient(network.assetHub.ws);
    assetHubClient = ah.client;
    assetHubApi = ah.api;

    const bulletin = createBulletinClient(network.bulletin.ws);
    bulletinClient = bulletin.client;
    bulletinApi = bulletin.api;
  });

  afterAll(() => {
    peopleClient?.destroy();
    assetHubClient?.destroy();
    bulletinClient?.destroy();
  });

  it(
    "People chain is producing finalized blocks",
    async () => {
      try {
        await probeChainProducing({
          chain: "people",
          label: "People",
          blockSeconds: PEOPLE_BLOCK_SECONDS,
          freshnessBudgetMs: MAX_PEOPLE_FRESHNESS_MS,
          maxBlocksStale: MAX_PEOPLE_BLOCKS_STALE,
          client: peopleClient,
          getTimestampAt: async (hash) => Number(await peopleApi.query.Timestamp.Now.getValue({ at: hash })),
        });
      } catch (err) {
        markChainUnhealthy("people", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    FINALIZED_BLOCK_PROBE_MS,
  );

  it(
    "Asset Hub chain is producing finalized blocks",
    async () => {
      try {
        await probeChainProducing({
          chain: "asset-hub",
          label: "Asset Hub",
          blockSeconds: AH_BLOCK_SECONDS,
          freshnessBudgetMs: MAX_AH_FRESHNESS_MS,
          maxBlocksStale: MAX_AH_BLOCKS_STALE,
          client: assetHubClient,
          getTimestampAt: async (hash) => Number(await assetHubApi.query.Timestamp.Now.getValue({ at: hash })),
        });
      } catch (err) {
        markChainUnhealthy("asset-hub", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    FINALIZED_BLOCK_PROBE_MS,
  );

  it(
    "Bulletin chain is producing finalized blocks",
    async () => {
      try {
        await probeChainProducing({
          chain: "bulletin",
          label: "Bulletin",
          blockSeconds: BULLETIN_BLOCK_SECONDS,
          freshnessBudgetMs: MAX_BULLETIN_FRESHNESS_MS,
          maxBlocksStale: MAX_BULLETIN_BLOCKS_STALE,
          client: bulletinClient,
          getTimestampAt: async (hash) => Number(await bulletinApi.query.Timestamp.Now.getValue({ at: hash })),
        });
      } catch (err) {
        markChainUnhealthy("bulletin", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    FINALIZED_BLOCK_PROBE_MS,
  );
});
