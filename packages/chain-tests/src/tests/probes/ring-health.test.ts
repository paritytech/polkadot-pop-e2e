/**
 * Ring health probe — three independent verdicts on the LitePeople ring.
 *
 * Why this exists: every newly-attested LitePeople member enters
 * `Members.Members` in the `Onboarding` state and stays there until the
 * offchain ring-builder worker batches them into a ring and emits
 * `Members::RingBuilt`. Until that happens, the member cannot generate
 * ring-VRF proofs — pair-confirms, allowance grants, PGAS claims, and
 * statement-store writes all fail.
 *
 * Three verdicts, one job each:
 *
 *   1. AH ring-root mirror caught up
 *      AssetHub's `MembersSubscriber.RingRoots` is at most one revision
 *      behind People's `Members.Root`. XCM propagation issue if it falls
 *      further behind.
 *
 *   2. Ring is not STUCK stale
 *      `Members.StaleRings` flags rings the runtime ITSELF considers overdue
 *      for a rebuild — chain-side authoritative signal, no event-timing
 *      heuristics. But a momentary flag is normal churn (chain flags → OCW
 *      rebuilds → clears), so we re-poll and fail only on a ring that stays
 *      stale across the confirm window. Mirrors the monitor's RingBuilderStalled
 *      `for: 30s` so probe and alert agree on "stuck".
 *
 *   3. Build latency within 1 minute
 *      If there are members waiting in `Onboarding`, the last
 *      `RingBuilt(LitePeople)` event must have fired within 30 finalized
 *      People blocks (~1 min @ 2 s/block). Quiet chains with empty
 *      queues PASS unconditionally.
 *
 * Why @polkadot/api here instead of PAPI 2.x: the previous PAPI-based
 * version of this probe was flaky against paseo-next-v2 and summit
 * endpoints (Invalid block hash / ChainHead disjointed surfacing
 * asynchronously from PAPI's chainHead subscription stream — root
 * cause not fully diagnosed). The @polkadot/api client uses legacy v1
 * RPC (`state_getStorage`, `chain_getFinalizedHead`) and runs 100%
 * reliably against the same endpoints (measured 25/25 on 2026-06-15
 * across paseo-next-v2, previewnet, summit).
 *
 * The rest of chain-tests stays on PAPI 2.x — those tests exercise
 * what dApps do. This probe is a canary; using a different client here
 * is a feature: if both clients fail the chain is broken, if only PAPI
 * fails it's a client-stack issue, not a chain issue.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";
import { LITE_PEOPLE_IDENTIFIER } from "../../lib/ring.js";
import { markChainUnhealthy } from "../../lib/chain-cascade.js";

// Both People and AssetHub run at 2 s/block on every network we probe.
const PEOPLE_BLOCK_SECONDS = 2;
const AH_BLOCK_SECONDS = 2;

// SLA for LitePeople: MemberAdded → RingBuilt within ~1 min. At 2 s/block
// that's 30 blocks. Past this the offchain ring-builder is no longer
// keeping up and freshly-attested users can't generate ring-VRF proofs.
const BUILD_SLA_BLOCKS = 30;

// How far back to look for the most recent RingBuilt(LitePeople) event.
// We only need to discriminate "≤ SLA" vs "> SLA"; 60 blocks (~2 min)
// gives 2× SLA headroom for diagnostics.
const HISTORY_BLOCKS = 60;

// A ring momentarily appearing in `Members.StaleRings` is the HAPPY path: the
// chain flags it, the offchain builder rebuilds within a block or two, and the
// flag clears — all within seconds. Only a ring that stays stale CONTINUOUSLY
// is genuinely stuck. So we don't fail on a single instantaneous read; we
// re-poll across this window and fail only on rings stale on every sample.
// Mirrors the monitor's `RingBuilderStalled` alert, which requires the stale
// signal to persist for `for: 30s` before firing (monitor/src/alerts.ts). The
// previous one-shot check flapped red on every run that happened to sample
// mid-rebuild (e.g. run 27961929575: stale=[77] one instant, clear the next).
const STALE_CONFIRM_WINDOW_MS = 35_000;
const STALE_POLL_INTERVAL_MS = 3_000;

// End-to-end ring-root propagation budget in AH revisions.
const AH_CATCHUP_BUDGET_REVS_BY_NETWORK: Record<string, number> = {
  "paseo-next-v2": 1,
  previewnet: 1,
};
const DEFAULT_AH_CATCHUP_BUDGET_REVS = 1;

// Downstream fail-fast gate for the AH-catchup verdict. The verdict
// itself FAILS at budget (1 rev) to flag the SLA breach, but we only
// mark asset-hub unhealthy — short-circuiting every feature suite's
// beforeAll via `assertChainHealthy("asset-hub")` — once AH is far
// enough behind that PGAS's `waitForAssetHubRing` would hang rather
// than catch up. Mirrors the threshold the Chain Health probe used
// before this check moved here (2026-06-03 paseo-next-v2 incident);
// keeps transient 1-2 rev XCM jitter from fail-fasting the whole suite.
const AH_CASCADE_LAG_THRESHOLD = 3;

// 32-byte ASCII collection identifier → 0x-prefixed hex string for
// event-data comparison and storage key prefixing.
function uint8ToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
const COLLECTION_HEX = uint8ToHex(LITE_PEOPLE_IDENTIFIER);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface WalkResult {
  /** Block number of the most recent RingBuilt(LitePeople), or null if none in window. */
  lastBuiltBlock: number | null;
  rebuiltCount: number;
  onboardedCount: number;
  startBlock: number;
  endBlock: number;
}

/**
 * Walk the last HISTORY_BLOCKS finalized blocks looking for the most
 * recent RingBuilt event filtered to LITE_PEOPLE_IDENTIFIER. Early-exit
 * the moment we find one, otherwise scan the whole window.
 */
async function findLastRingBuilt(api: ApiPromise): Promise<WalkResult> {
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(finalizedHash);
  const endBlock = header.number.toNumber();
  const startBlock = Math.max(0, endBlock - HISTORY_BLOCKS + 1);

  console.log(
    `[ring-health] Walking blocks ${startBlock}..${endBlock} from tip ${finalizedHash.toHex().slice(0, 12)}… for RingBuilt events`,
  );

  let lastBuiltBlock: number | null = null;
  let rebuiltCount = 0;
  let onboardedCount = 0;

  for (let n = endBlock; n >= startBlock; n--) {
    const hash = await api.rpc.chain.getBlockHash(n);
    const events = await api.query.system.events.at(hash);
    for (const record of events as unknown as { event: { section: string; method: string; data: { toHex(): string }[] } }[]) {
      const { event } = record;
      if (event.section !== "members") continue;
      if (event.method === "RingBuilt") {
        const id = event.data[0].toHex();
        if (id === COLLECTION_HEX) {
          rebuiltCount++;
          if (lastBuiltBlock === null) lastBuiltBlock = n;
        }
      } else if (event.method === "MembersOnboarded") {
        const id = event.data[0].toHex();
        if (id === COLLECTION_HEX) onboardedCount++;
      }
    }
    const scanned = endBlock - n + 1;
    if (scanned % 25 === 0) {
      console.log(
        `[ring-health]   scanned ${scanned}/${HISTORY_BLOCKS} (rebuilt=${rebuiltCount} onboarded=${onboardedCount} lastBuilt=${lastBuiltBlock ?? "none"})`,
      );
    }
  }

  console.log(
    `[ring-health] Walk complete: rebuilt=${rebuiltCount} onboarded=${onboardedCount} lastBuiltBlock=${lastBuiltBlock ?? "none"}`,
  );
  return { lastBuiltBlock, rebuiltCount, onboardedCount, startBlock, endBlock };
}

/**
 * Queue depth = count of LitePeople members currently in `Onboarding` state.
 * Same approach the monitor's ring-builder watcher uses.
 */
async function readQueueDepth(api: ApiPromise): Promise<number> {
  const entries = await api.query.members.members.entries(COLLECTION_HEX);
  let onboarding = 0;
  for (const [, value] of entries) {
    const v = (value as unknown as { isOnboarding?: boolean; type?: string });
    if (v.isOnboarding === true || v.type === "Onboarding") onboarding++;
  }
  return onboarding;
}

/**
 * Read `Members.StaleRings` and filter to LitePeople. The runtime maintains
 * this set — an entry exists iff the chain itself thinks the ring is overdue
 * for a rebuild. Authoritative chain-side signal; no heuristic.
 */
async function readStaleRings(api: ApiPromise): Promise<number[]> {
  const entries = await api.query.members.staleRings.entries();
  const stale: number[] = [];
  for (const [storageKey] of entries) {
    const args = storageKey.args;
    if (args.length < 2) continue;
    const coll = (args[0] as unknown as { toHex(): string }).toHex();
    const ringIndex = (args[1] as unknown as { toNumber(): number }).toNumber();
    if (coll === COLLECTION_HEX) stale.push(ringIndex);
  }
  return stale.sort((a, b) => a - b);
}

async function ahCatchupLag(
  peopleApi: ApiPromise,
  ahApi: ApiPromise,
  ringIndex = 0,
): Promise<{ peopleRev: number | null; ahMaxRev: number | null; deltaRev: number | null }> {
  const peopleRoot = (await peopleApi.query.members.root(
    COLLECTION_HEX,
    ringIndex,
  )) as unknown as { isSome: boolean; unwrap(): { revision: { toNumber(): number } } };
  const peopleRev = peopleRoot.isSome ? peopleRoot.unwrap().revision.toNumber() : null;

  // individuality v0.12.0 (previewnet AH 2000038) keys RingRoots by
  // (generation, identifier, ring_index), with CurrentGeneration holding the live
  // prefix; older runtimes (pnv2's 2000036) key by (identifier, ring_index).
  // Query whichever shape this runtime exposes.
  const ringRootsQuery = ahApi.query.membersSubscriber.ringRoots;
  const ahRoots = (ahApi.query.membersSubscriber.currentGeneration
    ? await ringRootsQuery(
        await ahApi.query.membersSubscriber.currentGeneration(),
        COLLECTION_HEX,
        ringIndex,
      )
    : await ringRootsQuery(COLLECTION_HEX, ringIndex)) as unknown as {
    toJSON(): { revision: number }[] | null | undefined;
  };
  const roots = ahRoots.toJSON();
  const ahMaxRev =
    Array.isArray(roots) && roots.length > 0
      ? Math.max(...roots.map((r) => r.revision))
      : null;

  const deltaRev = peopleRev !== null && ahMaxRev !== null ? peopleRev - ahMaxRev : null;
  return { peopleRev, ahMaxRev, deltaRev };
}

describe("LitePeople ring health", () => {
  let network: NetworkConfig;
  let peopleApi: ApiPromise;
  let ahApi: ApiPromise;
  let ahHasMembersSubscriber = false;
  let ahCatchupBudgetRevs: number;
  let walk: WalkResult;
  let queueDepth: number;
  let staleRings: number[];
  let setupError: Error | null = null;

  beforeAll(async () => {
    try {
      network = getNetworkConfig();
      console.log(`[ring-health] Network: ${network.name}`);
      console.log(`[ring-health] People RPC: ${network.people.ws}`);
      console.log(`[ring-health] AssetHub RPC: ${network.assetHub.ws}`);

      const networkKey =
        process.env.NETWORK ?? network.name.toLowerCase().replace(/\s+/g, "-");
      ahCatchupBudgetRevs =
        AH_CATCHUP_BUDGET_REVS_BY_NETWORK[networkKey] ?? DEFAULT_AH_CATCHUP_BUDGET_REVS;
      console.log(
        `[ring-health] AH catch-up budget for ${network.name} (key=${networkKey}): ${ahCatchupBudgetRevs} revision(s)`,
      );

      peopleApi = await ApiPromise.create({
        provider: new WsProvider(network.people.ws),
        noInitWarn: true,
        throwOnConnect: true,
      });
      ahApi = await ApiPromise.create({
        provider: new WsProvider(network.assetHub.ws),
        noInitWarn: true,
        throwOnConnect: true,
      });

      // AH ships MembersSubscriber on paseo-next-v2 + previewnet only.
      // Detect by metadata presence so the AH-catchup test gracefully no-ops
      // on legacy chains rather than throwing during query.
      ahHasMembersSubscriber =
        typeof (ahApi.query as Record<string, unknown>).membersSubscriber === "object";

      staleRings = await readStaleRings(peopleApi);
      queueDepth = await readQueueDepth(peopleApi);
      walk = await findLastRingBuilt(peopleApi);

      console.log(
        `[ring-health] Setup complete: queueDepth=${queueDepth} staleRings=[${staleRings.join(",")}] lastBuiltBlock=${walk.lastBuiltBlock ?? "none"} window=${walk.startBlock}..${walk.endBlock} ah_has_membersSubscriber=${ahHasMembersSubscriber}`,
      );
    } catch (err) {
      setupError = err instanceof Error ? err : new Error(String(err));
      console.error(`[ring-health] setup failed — tests will fail with: ${setupError.message}`);
    }
  }, 120_000);

  function assertSetupOk(): void {
    if (setupError) throw setupError;
  }

  afterAll(async () => {
    try {
      await peopleApi?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      await ahApi?.disconnect();
    } catch {
      // already disconnected
    }
  });

  it("AssetHub ring-root mirror caught up with People", { timeout: 60_000 }, async () => {
    assertSetupOk();
    if (!ahHasMembersSubscriber) {
      console.log(
        `[ring-health] METRIC test=ah_catchup applicable=false network=${network.name}`,
      );
      expect(true).toBe(true);
      return;
    }
    const lag = await ahCatchupLag(peopleApi, ahApi);
    const estAhLagSec =
      lag.deltaRev !== null
        ? lag.deltaRev * (PEOPLE_BLOCK_SECONDS + 3 * AH_BLOCK_SECONDS)
        : null;
    console.log(
      `[ring-health] METRIC test=ah_catchup applicable=true ` +
        `people_rev=${lag.peopleRev ?? "na"} ah_max_rev=${lag.ahMaxRev ?? "na"} ` +
        `delta_rev=${lag.deltaRev ?? "na"} budget_revs=${ahCatchupBudgetRevs} ` +
        `est_seconds_behind=${estAhLagSec ?? "na"}`,
    );

    if (lag.peopleRev === null) return;
    if (lag.ahMaxRev === null) {
      // People has a ring but AH mirrors nothing — definitively stuck,
      // not transient lag. Fail-fast every AH-dependent feature suite so
      // PGAS / ring-VRF tests don't hang on `waitForAssetHubRing`.
      const reason =
        `AssetHub mirror empty: People rev=${lag.peopleRev}, AH RingRoots empty. ` +
        `Ring root has never propagated to AssetHub for LitePeople.`;
      markChainUnhealthy("asset-hub", `[ring-health] ${reason}`);
      throw new Error(`[ring-health] ${reason}`);
    }
    if (lag.deltaRev !== null && lag.deltaRev > ahCatchupBudgetRevs) {
      const reason =
        `AssetHub mirror behind by ${lag.deltaRev} revision(s) (budget=${ahCatchupBudgetRevs}): ` +
        `People=${lag.peopleRev}, AH max=${lag.ahMaxRev}. ` +
        `XCM ring-root propagation lagging; estimated ~${estAhLagSec}s behind.`;
      // Only fail-fast downstream once AH is definitively stuck — a
      // 1-2 rev lag is normal XCM jitter that PGAS's own ring-sync wait
      // absorbs, so cascading there would turn jitter into a red suite.
      if (lag.deltaRev > AH_CASCADE_LAG_THRESHOLD) {
        markChainUnhealthy("asset-hub", `[ring-health] ${reason}`);
      }
      throw new Error(`[ring-health] ${reason}`);
    }
  });

  it(
    "LitePeople ring not marked stale by chain",
    { timeout: STALE_CONFIRM_WINDOW_MS + 25_000 },
    async () => {
      assertSetupOk();
      console.log(
        `[ring-health] METRIC test=stale_ring stale_count=${staleRings.length} stale_ring_indices=[${staleRings.join(",")}]`,
      );
      // Fast path: nothing flagged at first observation.
      if (staleRings.length === 0) {
        expect(true).toBe(true);
        return;
      }

      // A stale flag alone is normal rebuild churn. Re-poll across
      // STALE_CONFIRM_WINDOW_MS (> the monitor's `for: 30s`) and keep only the
      // rings that were stale at the start AND remained stale on every sample.
      // A ring that clears at any point was being rebuilt normally; intersecting
      // each poll against the survivors drops it. Match the monitor so the probe
      // and the RingBuilderStalled alert agree on what "stuck" means.
      let stuck = new Set(staleRings);
      const deadline = Date.now() + STALE_CONFIRM_WINDOW_MS;
      let polls = 1;
      while (Date.now() < deadline && stuck.size > 0) {
        await delay(STALE_POLL_INTERVAL_MS);
        polls++;
        const current = new Set(await readStaleRings(peopleApi));
        stuck = new Set([...stuck].filter((r) => current.has(r)));
        console.log(
          `[ring-health] stale re-poll ${polls}: current=[${[...current]
            .sort((a, b) => a - b)
            .join(",")}] still-stuck=[${[...stuck].sort((a, b) => a - b).join(",")}]`,
        );
      }

      if (stuck.size === 0) {
        console.log(
          `[ring-health] METRIC test=stale_ring stale_verdict=churn stale_polls=${polls} ` +
            `stale_window_s=${STALE_CONFIRM_WINDOW_MS / 1000}`,
        );
        expect(true).toBe(true);
        return;
      }

      const stuckIdx = [...stuck].sort((a, b) => a - b);
      console.log(
        `[ring-health] METRIC test=stale_ring stale_verdict=stuck stale_polls=${polls} ` +
          `stuck_ring_indices=[${stuckIdx.join(",")}]`,
      );
      const reason =
        `Ring(s) STUCK stale for LitePeople (${network.name}): ring_index=[${stuckIdx.join(",")}]. ` +
        `Members.StaleRings flagged these and they did NOT clear within ${STALE_CONFIRM_WINDOW_MS / 1000}s ` +
        `(${polls} polls) — the offchain builder is not landing a rebuild. ` +
        `If OCW is alive and submitting, the txpool may be rejecting the rebuild (fork-aware pool rotator-ban pattern). ` +
        `Chain-side fault, NOT a test bug — notify the individuality runtime team.`;
      throw new Error(
        `[ring-health] ${reason}\n` +
          `Effect: ring-VRF proofs against these rings will be rejected as stale by the runtime, ` +
          `breaking allowance claims, PGAS claims, statement writes, and bulletin uploads.`,
      );
    },
  );

  it(`LitePeople build latency within ${BUILD_SLA_BLOCKS} blocks (~${Math.round((BUILD_SLA_BLOCKS * PEOPLE_BLOCK_SECONDS) / 60)} min)`, () => {
    assertSetupOk();
    const tipBlock = walk.endBlock;
    const blocksSinceBuilt =
      walk.lastBuiltBlock !== null ? tipBlock - walk.lastBuiltBlock : HISTORY_BLOCKS;
    const lastBuiltKnown = walk.lastBuiltBlock !== null;
    const wallSecondsSinceBuilt = blocksSinceBuilt * PEOPLE_BLOCK_SECONDS;

    console.log(
      `[ring-health] METRIC test=build_latency ` +
        `queue_depth=${queueDepth} ` +
        `blocks_since_built=${blocksSinceBuilt}${lastBuiltKnown ? "" : "+"} ` +
        `sla_blocks=${BUILD_SLA_BLOCKS} ` +
        `seconds_since_built=${wallSecondsSinceBuilt} ` +
        `tip_block=${tipBlock} ` +
        `last_built_block=${walk.lastBuiltBlock ?? "none"} ` +
        `window_blocks=${HISTORY_BLOCKS} ` +
        `rebuilt_in_window=${walk.rebuiltCount} ` +
        `onboarded_in_window=${walk.onboardedCount}`,
    );

    if (queueDepth === 0) {
      console.log(`[ring-health] queue empty — build SLA not applicable, PASS`);
      return;
    }
    if (blocksSinceBuilt <= BUILD_SLA_BLOCKS) {
      console.log(
        `[ring-health] queue=${queueDepth} but rebuilt ${blocksSinceBuilt} block(s) ago (within ${BUILD_SLA_BLOCKS}-block SLA), PASS`,
      );
      return;
    }

    const slaSec = BUILD_SLA_BLOCKS * PEOPLE_BLOCK_SECONDS;
    const reason =
      `LitePeople build latency SLA broken on ${network.name}: ` +
      `${queueDepth} member(s) waiting in Onboarding; last RingBuilt was ${blocksSinceBuilt} block(s) ago ` +
      `(~${wallSecondsSinceBuilt}s); SLA is ${BUILD_SLA_BLOCKS} blocks (~${slaSec}s). ` +
      (lastBuiltKnown
        ? `Last rebuild at block ${walk.lastBuiltBlock}.`
        : `No RingBuilt event found in the last ${HISTORY_BLOCKS} blocks (~${Math.round((HISTORY_BLOCKS * PEOPLE_BLOCK_SECONDS) / 60)} min) — OCW silent or unable to deliver.`);
    throw new Error(
      `[ring-health] ${reason}\n` +
        `Effect: freshly-attested members cannot generate ring-VRF proofs until the next rebuild lands. ` +
        `Allowance claims, PGAS claims, statement writes, and bulletin uploads from those accounts will fail.`,
    );
  });
});
