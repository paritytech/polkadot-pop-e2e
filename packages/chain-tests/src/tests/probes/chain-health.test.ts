/**
 * First-line liveness probe for every chain in the suite. Runs ahead of
 * IB-health and every feature suite (see `package.json` test script
 * ordering) so an unhealthy chain surfaces at the top of the report
 * rather than being inferred from a 6-min PGAS hang.
 *
 * For each chain we record the verdict in `chain-cascade`; downstream
 * suites' beforeAlls call `assertChainHealthy(...)` and fail-fast off
 * the cached marker. This prevents the failure shape observed on
 * `paseo-next-v2` on 2026-06-03 where AH was producing blocks but its
 * `MembersSubscriber.RingRoots` window lagged People's revision,
 * causing PGAS's `waitForAssetHubRing` to hang for the full per-test
 * timeout (6 min) and overshoot the workflow's per-attempt retry cap.
 *
 * The probe deliberately does cheap checks only — no signed extrinsics,
 * no funded operations — so a 10-second probe failure means the chain
 * is genuinely broken, not "your test account is misconfigured".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import {
  createPeopleClient,
  createAssetHubClient,
  createBulletinClient,
  type PeopleApi,
  type AssetHubApi,
  type BulletinApi,
} from "../../lib/client.js";
import { markChainUnhealthy, type ChainName } from "../../lib/chain-cascade.js";
import { LITE_PEOPLE_IDENTIFIER } from "../../lib/ring.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";

// Per-test timeout. Covers the fast path (one RPC roundtrip, ~hundreds
// of ms on a healthy chain) AND the slow path that waits one
// ADVANCEMENT_WINDOW_MS to disambiguate "stale finality" from "chain
// stalled" — see probeChainProducing() below.
const FINALIZED_BLOCK_PROBE_MS = 30_000;

// When the fast path trips on stale finality, wait this long and
// re-read finalized block. If the number advanced, the chain is
// provably producing and the prior staleness was a normal finality
// batch — pass. If no advancement, this is a real stall.
//
// 12s is enough for both AH (≥6 blocks @ 2s) and People/Bulletin
// (≥2 blocks @ 6s) to advance at least one block on a healthy chain,
// regardless of where in the finality round we sampled.
const ADVANCEMENT_WINDOW_MS = 12_000;

// Per-chain block authoring cadence. People + Bulletin run at ~6s/block,
// AssetHub at ~2s/block (relay-driven async backing on parachains using
// the AH runtime). The freshness budgets below are derived from these so
// they stay correct if/when chain cadence changes — and so a slow
// AssetHub doesn't get the same generous slack as People just because
// they share a probe.
const PEOPLE_BLOCK_SECONDS = 6;
const AH_BLOCK_SECONDS = 2;
const BULLETIN_BLOCK_SECONDS = 6;

// "Latest finalized block is stale" budget per chain. Only consulted on
// the slow path (after a no-advancement sample). Healthy parachains can
// run 30-60s behind finality during normal operation (GRANDPA rounds,
// relay-chain backing); these budgets are deliberately generous so the
// advancement check is the gating signal, not absolute age. AH gets a
// bigger block-multiplier because its 2s cadence makes finality-age
// straddle the operating range — see 2026-06-11 false-fail incident.
const MAX_PEOPLE_BLOCKS_STALE = 30;
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

// Acceptable lag between People's latest LitePeople ring revision and
// the highest revision visible in AH's MembersSubscriber.RingRoots
// window. XCM carries revisions with a 30s–2min lag normally; ≥3
// revisions behind means the XCM bridge is stuck.
const AH_RING_LAG_THRESHOLD = 3;

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

  // Gated on features.pgas because the AH ring-roots window only
  // matters for tests that submit ring-VRF proofs (PGAS claim, etc.).
  // The lag itself is observable on any network that runs the XCM
  // members-subscriber pallet, but failing here would be a non-issue
  // for a network that doesn't use it.
  it.skipIf(!getNetworkConfig().features.pgas)(
    "Asset Hub ring-roots window keeps up with People",
    async () => {
      const idHex = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
      const ringIndex = 0;

      const peopleRoot = await peopleApi.query.Members.Root.getValue(idHex, ringIndex);
      const peopleRev = peopleRoot?.revision ?? -1;
      if (peopleRev < 0) {
        // No ring populated yet — nothing to compare. Treat as healthy
        // (a fresh network with no members; ring tests will skip on
        // their own when they can't find a member).
        console.log(`[chain-health] AH ring sync: no People ring revision yet (fresh network?)`);
        return;
      }

      // `assetHubApi` is the union type that may or may not include
      // MembersSubscriber. Skip the check on networks that don't ship
      // the pallet — features.pgas already gates that, but assert at
      // runtime to make the types line up.
      const queries = assetHubApi.query as unknown as {
        MembersSubscriber?: {
          RingRoots: {
            getValue(
              id: string,
              ringIndex: number,
            ): Promise<Array<{ revision: number }> | undefined>;
          };
        };
      };
      const ahRoots = (await queries.MembersSubscriber?.RingRoots.getValue(idHex, ringIndex)) ?? [];
      const ahMaxRev = ahRoots.length === 0 ? -1 : Math.max(...ahRoots.map((r) => r.revision));
      const lag = peopleRev - ahMaxRev;
      console.log(
        `[chain-health] AH ring sync: people rev=${peopleRev}, AH max rev=${ahMaxRev}, lag=${lag}`,
      );

      if (lag > AH_RING_LAG_THRESHOLD) {
        const msg =
          `AH ring-roots window is ${lag} revisions behind People ` +
          `(people=${peopleRev}, AH=${ahMaxRev}, threshold=${AH_RING_LAG_THRESHOLD}). ` +
          `XCM members-subscriber is stuck; PGAS / ring-VRF tests would hang.`;
        markChainUnhealthy("asset-hub", msg);
        throw new Error(msg);
      }
    },
    30_000,
  );
});
