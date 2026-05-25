/**
 * Ring-health: measure People-chain ring rebuild latency from recent
 * block events.
 *
 * Why this exists: every newly-attested lite-person enters
 * `Members.Members` in the `Onboarding` state and must be batched into
 * the ring via an offchain ring-rebuild worker. Until that rebuild
 * lands and the new ring root is committed, the member can't generate
 * ring-VRF proofs — pair-confirms, allowance grants, and PGAS claims
 * all fail with `Ring member doesn't included into the ring`.
 *
 * On a healthy chain, the rebuild fires within a few blocks of the
 * Onboarding event. We've observed paseo-next-v2 stalling for 5–8
 * minutes, blocking every triangle-e2e CI shard.
 *
 * What we measure: walk the last N finalized blocks, collect
 * `Members::MembersOnboarded` and `Members::RingBuilt` events per
 * collection, pair each Onboarded event with the next RingBuilt for
 * the same collection, compute the block-delta. That's the submit →
 * rebuild latency.
 *
 * Why this beats a snapshot probe: we get *historical* latency without
 * waiting. A snapshot probe across 90 s only catches lag spikes that
 * are happening right when CI runs. Walking 50 finalized blocks gives
 * us ~5 minutes of history per run — enough to catch intermittent
 * spikes.
 *
 * Verdict (per collection):
 *   - no onboarded events in window         → PASS (no work, no signal)
 *   - every onboarded paired within N blocks → PASS
 *   - any onboarded unpaired or paired with > MAX_PEOPLE_REBUILD_BLOCKS gap
 *     → FAIL with the worst-case latency in the message
 *
 * The probe emits structured `[ring-health] METRIC …` lines so the
 * same test can feed a Grafana dashboard without re-instrumenting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import {
  createPeopleClient,
  createAssetHubClient,
  assertRichAssetHub,
  type PeopleApi,
  type AssetHubApi,
  type RichAssetHubApi,
} from "../../lib/client.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";
import { LITE_PEOPLE_IDENTIFIER } from "../../lib/ring.js";

// How many finalized blocks back to walk. 200 blocks × ~6 s ≈ 20 min of
// history. Wide enough to catch sparse onboarding traffic on testnets;
// 200 sequential RPC reads finish in 30–60 s on a healthy endpoint.
const HISTORY_BLOCKS = 200;

// Healthy rebuild lag in PEOPLE BLOCKS (People-side leg only). People-chain
// runs at ~6 s/block. Onboarded members appear in `RingBuilt` within 1–2
// blocks under load; 2 blocks (~12 s) is our healthy ceiling for this leg.
// Past 2 blocks the offchain rebuild worker is queueing — which is what
// triggered the cascade of pair-confirm failures we saw on 2026-05-19.
const MAX_PEOPLE_REBUILD_BLOCKS = 2;

// End-to-end ring-root propagation budget, in REVISIONS that AssetHub may
// lag behind People. Measured as `peopleRev - ahMaxRev`:
//   - delta = 0  → AH is fully caught up
//   - delta = 1  → a rebuild just landed on People and the XCM message
//                  hasn't been consumed on AH yet (in-flight, healthy)
//   - delta ≥ 2  → AH is genuinely behind; users will see stale ring roots
//
// Product expectation:
//   - paseo-next-v2: 15–20 s e2e (People 6 s rebuild + AH 2 s/block catch-up)
//   - previewnet:    25–30 s e2e (slower XCM path)
// Both fit comfortably inside `delta ≤ 1`. Tighten if false positives stay
// at zero; loosen if intermittent traffic produces alarms.
const AH_CATCHUP_BUDGET_REVS_BY_NETWORK: Record<string, number> = {
  "paseo-next-v2": 1,
  previewnet: 1,
};
const DEFAULT_AH_CATCHUP_BUDGET_REVS = 1;

// Block times for human-readable estimates only — verdict logic uses
// counts (blocks / revisions), not seconds, so the test stays correct if
// chain block times change.
const PEOPLE_BLOCK_SECONDS = 6;
const AH_BLOCK_SECONDS = 2;

interface EventOccurrence {
  blockNumber: number;
  blockHash: string;
}

interface CollectionStats {
  /** Onboarded events that have NOT been paired with a subsequent RingBuilt. */
  unpaired: EventOccurrence[];
  /** Block-delta from each paired Onboarded to its matching RingBuilt. */
  latenciesInBlocks: number[];
  /** Raw count of RingBuilt events (across all ring_index values). */
  rebuiltCount: number;
  /** Raw count of MembersOnboarded events. */
  onboardedCount: number;
}

function emptyStats(): CollectionStats {
  return {
    unpaired: [],
    latenciesInBlocks: [],
    rebuiltCount: 0,
    onboardedCount: 0,
  };
}

/**
 * Walk the last `HISTORY_BLOCKS` finalized blocks and collect Members
 * pallet events. Returns events grouped by event type → array of
 * `{ blockNumber, blockHash, collectionId }`.
 *
 * `api.event.Members.<X>.pull(at)` reads system.events at the block
 * hash and filters to that specific event variant — much cheaper than
 * pulling the full events vec and filtering ourselves.
 */
async function collectMembersEvents(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
): Promise<{
  onboardedByCollection: Map<string, EventOccurrence[]>;
  rebuiltByCollection: Map<string, EventOccurrence[]>;
  startBlock: number;
  endBlock: number;
}> {
  const fin = await peopleClient.getFinalizedBlock();
  const endBlock = fin.number;
  const startBlock = Math.max(0, endBlock - HISTORY_BLOCKS + 1);

  const onboardedByCollection = new Map<string, EventOccurrence[]>();
  const rebuiltByCollection = new Map<string, EventOccurrence[]>();

  // PAPI 2.x doesn't expose `getBlockHash(number)`; walk backwards from the
  // finalized tip via `header.parentHash` to collect (hash, number) pairs.
  // ~200 sequential `getBlockHeader` + 2× `event.get` calls per block
  // finishes in 30–90 s on a healthy RPC. We log progress every
  // `PROGRESS_EVERY_N` blocks so a stuck step is visible rather than
  // appearing as a 90 s silence in CI logs.
  const PROGRESS_EVERY_N = 25;
  console.log(
    `[ring-health] Collecting hashes for blocks ${startBlock}..${endBlock} from tip ${fin.hash.slice(0, 10)}…`,
  );
  const blocks: Array<{ number: number; hash: string }> = [
    { number: endBlock, hash: fin.hash },
  ];
  let cursorHash: string = fin.hash;
  for (let n = endBlock - 1; n >= startBlock; n--) {
    const header = await peopleClient.getBlockHeader(cursorHash);
    cursorHash = header.parentHash;
    blocks.push({ number: n, hash: cursorHash });
    const fetched = blocks.length;
    if (fetched % PROGRESS_EVERY_N === 0) {
      console.log(
        `[ring-health]   hashes: ${fetched}/${endBlock - startBlock + 1}`,
      );
    }
  }

  console.log(
    `[ring-health] Reading MembersOnboarded + RingBuilt events for ${blocks.length} blocks…`,
  );
  let processed = 0;
  let onboardedTotal = 0;
  let rebuiltTotal = 0;
  for (const blk of blocks) {
    const onboarded = await peopleApi.event.Members.MembersOnboarded.get(
      blk.hash as `0x${string}`,
    );
    for (const ev of onboarded) {
      const cid = ev.payload.identifier;
      const list = onboardedByCollection.get(cid) ?? [];
      list.push({ blockNumber: blk.number, blockHash: blk.hash });
      onboardedByCollection.set(cid, list);
      onboardedTotal++;
    }

    const rebuilt = await peopleApi.event.Members.RingBuilt.get(
      blk.hash as `0x${string}`,
    );
    for (const ev of rebuilt) {
      const cid = ev.payload.identifier;
      const list = rebuiltByCollection.get(cid) ?? [];
      list.push({ blockNumber: blk.number, blockHash: blk.hash });
      rebuiltByCollection.set(cid, list);
      rebuiltTotal++;
    }

    processed++;
    if (processed % PROGRESS_EVERY_N === 0) {
      console.log(
        `[ring-health]   events: ${processed}/${blocks.length}  ` +
          `(running totals: onboarded=${onboardedTotal} rebuilt=${rebuiltTotal})`,
      );
    }
  }
  console.log(
    `[ring-health] Walk complete: ${blocks.length} blocks scanned, onboarded=${onboardedTotal} rebuilt=${rebuiltTotal}`,
  );

  return { onboardedByCollection, rebuiltByCollection, startBlock, endBlock };
}

/**
 * Pair each Onboarded event with the NEXT RingBuilt event for the same
 * collection. Each RingBuilt can clear many queued Onboardeds at once
 * (the rebuild is batched), so multiple Onboarded entries map to the
 * same RingBuilt block — that's still a single rebuild from each
 * onboarded member's perspective. Onboarded events left unpaired at
 * the end of the window mean the rebuild hasn't happened yet → stuck.
 */
function pairEvents(
  onboardedRaw: EventOccurrence[],
  rebuiltRaw: EventOccurrence[],
): CollectionStats {
  // We walk blocks backwards from the tip, so the raw event arrays land in
  // REVERSE chronological order. Sort ascending so `find` returns the
  // *first* RingBuilt at-or-after each Onboarded event.
  const onboarded = [...onboardedRaw].sort((a, b) => a.blockNumber - b.blockNumber);
  const rebuilt = [...rebuiltRaw].sort((a, b) => a.blockNumber - b.blockNumber);

  const stats = emptyStats();
  stats.onboardedCount = onboarded.length;
  stats.rebuiltCount = rebuilt.length;

  for (const onb of onboarded) {
    const next = rebuilt.find((rb) => rb.blockNumber >= onb.blockNumber);
    if (next) {
      stats.latenciesInBlocks.push(next.blockNumber - onb.blockNumber);
    } else {
      stats.unpaired.push(onb);
    }
  }
  return stats;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Snapshot the current state of a collection's onboarding queue and ring
 * root revision. Used as a fallback signal when the event-walk window
 * has zero submissions — a busy queue with no recent rebuild is the
 * classic "stuck builder" shape even when we have no MembersOnboarded
 * event to pair against.
 */
async function snapshotCurrentState(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  collectionIdHex: string,
): Promise<{ revision: number | null; onboardingQueueDepth: number; ringSize: number }> {
  const fin = await peopleClient.getFinalizedBlock();
  const at = { at: fin.hash as `0x${string}` };
  const root = await peopleApi.query.Members.Root.getValue(collectionIdHex, 0, at);
  const allMembers = await peopleApi.query.Members.Members.getEntries(
    collectionIdHex,
    at,
  );
  let onboarding = 0;
  let included = 0;
  for (const entry of allMembers) {
    const t = entry.value?.type;
    if (t === "Onboarding") onboarding++;
    else if (t === "Included") included++;
  }
  return {
    revision: root?.revision ?? null,
    onboardingQueueDepth: onboarding,
    ringSize: included,
  };
}

/**
 * Compare People-side current ring revision against AssetHub's max accepted
 * revision in `MembersSubscriber.RingRoots`. Lag is reported as the integer
 * delta `peopleRev - ahMaxRev`; healthy chains report 0 (AH has the latest)
 * or 1 (AH is one rebuild behind, expected at the moment of a rebuild).
 *
 * AH lag isn't a block-count exactly — it's a revision-count which maps
 * roughly to "number of ring rebuilds yet to be propagated". On a healthy
 * chain rebuilds happen at most every few blocks under load, so lag in
 * revisions ≈ lag in block-equivalents up to a small constant.
 */
async function ahCatchupLag(
  assetHubApi: RichAssetHubApi,
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  collectionIdHex: string,
  ringIndex = 0,
): Promise<{ peopleRev: number | null; ahMaxRev: number | null; deltaRev: number | null }> {
  const fin = await peopleClient.getFinalizedBlock();
  const at = { at: fin.hash as `0x${string}` };
  const peopleRoot = await peopleApi.query.Members.Root.getValue(
    collectionIdHex,
    ringIndex,
    at,
  );
  const peopleRev = peopleRoot?.revision ?? null;

  const ahRoots =
    (await assetHubApi.query.MembersSubscriber.RingRoots.getValue(
      collectionIdHex,
      ringIndex,
    )) ?? [];
  const ahMaxRev =
    ahRoots.length === 0 ? null : Math.max(...ahRoots.map((r) => r.revision));

  const deltaRev =
    peopleRev != null && ahMaxRev != null ? peopleRev - ahMaxRev : null;

  return { peopleRev, ahMaxRev, deltaRev };
}

describe("People-chain ring rebuild latency", () => {
  let network: NetworkConfig;
  let peopleClient: PolkadotClient;
  let peopleApi: PeopleApi;
  let assetHubClient: PolkadotClient;
  let assetHubApi: AssetHubApi;
  let walk: Awaited<ReturnType<typeof collectMembersEvents>>;
  let ahCatchupBudgetRevs: number;
  const snapshotByCollection = new Map<
    string,
    Awaited<ReturnType<typeof snapshotCurrentState>>
  >();

  beforeAll(async () => {
    network = getNetworkConfig();
    console.log(`[ring-health] Network: ${network.name}`);
    console.log(`[ring-health] People RPC: ${network.people.ws}`);
    console.log(`[ring-health] AssetHub RPC: ${network.assetHub.ws}`);

    // `network.name` is the display name ("Paseo Next v2"); the threshold
    // map keys on the env-var-style slug ("paseo-next-v2"). Use the env
    // value when present, fall back to slugifying the display name so the
    // probe still gets a sensible budget if invoked without NETWORK set.
    const networkKey =
      process.env.NETWORK ?? network.name.toLowerCase().replace(/\s+/g, "-");
    ahCatchupBudgetRevs =
      AH_CATCHUP_BUDGET_REVS_BY_NETWORK[networkKey] ??
      DEFAULT_AH_CATCHUP_BUDGET_REVS;
    console.log(
      `[ring-health] AH catch-up budget for ${network.name} (key=${networkKey}): ${ahCatchupBudgetRevs} revision(s) behind`,
    );

    const peopleConn = createPeopleClient(network.people.ws);
    peopleClient = peopleConn.client;
    peopleApi = peopleConn.api;

    const ahConn = createAssetHubClient(network.assetHub.ws);
    assetHubClient = ahConn.client;
    assetHubApi = ahConn.api;

    walk = await collectMembersEvents(peopleApi, peopleClient);
    console.log(
      `[ring-health] Walked blocks ${walk.startBlock}..${walk.endBlock} (${walk.endBlock - walk.startBlock + 1} blocks, ~${Math.round(((walk.endBlock - walk.startBlock + 1) * PEOPLE_BLOCK_SECONDS) / 60)} min of People-chain history)`,
    );

    // Snapshot per collection once — both `it` blocks read from the map.
    for (const id of [LITE_PEOPLE_IDENTIFIER]) {
      const cid = Binary.toHex(id);
      snapshotByCollection.set(
        cid,
        await snapshotCurrentState(peopleApi, peopleClient, cid),
      );
    }
  }, 180_000);

  afterAll(() => {
    peopleClient?.destroy();
    assetHubClient?.destroy();
  });

  // We only probe `LitePeople` — that's the collection product flows depend
  // on (pair-confirm, allowances, signing). The full `People` collection
  // rebuilds far less often (a diagnostic walk on 2026-05-20 found 3
  // rebuilds in 2000 blocks vs LitePeople's 9, ~67 min apart on average),
  // so any reasonable "queue non-empty + zero rebuilds in N blocks" check
  // tuned to LitePeople's cadence would false-positive on People. The
  // probe is meant to surface "is the offchain ring-builder OCW running?"
  // — LitePeople is the right gauge for that.
  const collections: Array<{ name: string; id: Uint8Array }> = [
    { name: "LitePeople", id: LITE_PEOPLE_IDENTIFIER },
  ];

  for (const { name, id } of collections) {
    it(
      `${name}: AssetHub ring-root mirror caught up`,
      { timeout: 60_000 },
      async () => {
        // paseo-next-v2 + previewnet ship the rich AssetHub runtime with
        // `MembersSubscriber`. Defensive narrow: if we ever point at a chain
        // that doesn't, emit "not applicable" and pass instead of crashing.
        try {
          assertRichAssetHub(assetHubApi);
        } catch {
          console.log(
            `[ring-health] METRIC collection=${name} ah_lag_applicable=false network=${network.name}`,
          );
          expect(true).toBe(true);
          return;
        }
        const cid = Binary.toHex(id);
        const lag = await ahCatchupLag(assetHubApi, peopleApi, peopleClient, cid);
        console.log(
          `[ring-health] METRIC collection=${name} ah_lag_applicable=true ` +
            `people_rev=${lag.peopleRev ?? "na"} ah_max_rev=${lag.ahMaxRev ?? "na"} ` +
            `delta_rev=${lag.deltaRev ?? "na"} budget_revs=${ahCatchupBudgetRevs}`,
        );

        if (lag.peopleRev == null) {
          // No ring root on People yet — collection unused. Pass.
          return;
        }
        if (lag.ahMaxRev == null) {
          // People has a root, AH has nothing → real lag (or never propagated).
          throw new Error(
            `[ring-health] ${name}: People-side rev=${lag.peopleRev}, AH RingRoots window is empty. ` +
              `Ring root has never propagated to AssetHub for this collection.`,
          );
        }
        if (lag.deltaRev != null && lag.deltaRev > ahCatchupBudgetRevs) {
          throw new Error(
            `[ring-health] ${name}: AssetHub is ${lag.deltaRev} revision(s) behind People ` +
              `(People=${lag.peopleRev}, AH max=${lag.ahMaxRev}). Budget is ${ahCatchupBudgetRevs} ` +
              `revision(s) — XCM ring-root propagation is lagging.`,
          );
        }
      },
    );

    it(`${name} rebuilds within ${MAX_PEOPLE_REBUILD_BLOCKS} blocks of submit`, () => {
      const cid = Binary.toHex(id);
      const onboarded = walk.onboardedByCollection.get(cid) ?? [];
      const rebuilt = walk.rebuiltByCollection.get(cid) ?? [];
      const stats = pairEvents(onboarded, rebuilt);

      const sorted = [...stats.latenciesInBlocks].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      const worst = sorted.length > 0 ? sorted[sorted.length - 1] : null;

      // Structured metric line — keep field order stable for downstream
      // scrapers. block-deltas are unit-less here; multiply by
      // PEOPLE_BLOCK_SECONDS for a wall-clock estimate.
      console.log(
        `[ring-health] METRIC collection=${name} ` +
          `window_blocks=${walk.endBlock - walk.startBlock + 1} ` +
          `onboarded=${stats.onboardedCount} ` +
          `rebuilt=${stats.rebuiltCount} ` +
          `unpaired=${stats.unpaired.length} ` +
          `p50_blocks=${p50 ?? "na"} ` +
          `p95_blocks=${p95 ?? "na"} ` +
          `max_blocks=${worst ?? "na"}`,
      );

      // No onboarded events in the window — fall back to a snapshot check.
      // If the current queue is non-empty AND no rebuilds happened in the
      // entire window, the builder is stuck even though we couldn't
      // measure a specific submit→rebuild latency.
      if (stats.onboardedCount === 0) {
        const snap = snapshotByCollection.get(cid);
        const queueNow = snap?.onboardingQueueDepth ?? 0;
        console.log(
          `[ring-health] ${name}: no Onboarded events in window. Current snapshot: queue=${queueNow} ring=${snap?.ringSize ?? "na"} rev=${snap?.revision ?? "na"}`,
        );
        console.log(
          `[ring-health] METRIC collection=${name} window_blocks=${walk.endBlock - walk.startBlock + 1} ` +
            `onboarded_in_window=0 rebuilt_in_window=${stats.rebuiltCount} ` +
            `queue_now=${queueNow} ring_now=${snap?.ringSize ?? "na"} rev_now=${snap?.revision ?? "na"}`,
        );
        if (queueNow > 0 && stats.rebuiltCount === 0) {
          const windowBlocks = walk.endBlock - walk.startBlock + 1;
          const windowMin = Math.round((windowBlocks * PEOPLE_BLOCK_SECONDS) / 60);
          throw new Error(
            `[ring-health] Ring builder STUCK on ${name} (${network.name}).\n` +
              `Effect: new attestations cannot generate ring-VRF proofs. Allowance claims, PGAS claims, statement-store writes, and bulletin uploads will fail for any freshly-attested account on this network until the builder recovers.\n` +
              `Action: notify the individuality runtime team — this is a chain-side fault, NOT a test bug.\n` +
              `Numbers: ${queueNow} member(s) waiting in Onboarding right now; zero RingBuilt events across the last ${windowBlocks} People-chain blocks (~${windowMin} min); ring size=${snap?.ringSize ?? "na"}, current ring revision=${snap?.revision ?? "na"}.`,
          );
        }
        expect(true).toBe(true);
        return;
      }

      // Unpaired Onboarded events at the END of the window are the
      // strongest stuck-builder signal: a submission happened, no
      // rebuild followed. We tolerate up to MAX_PEOPLE_REBUILD_BLOCKS worth of
      // tail (a member onboarded in the last N blocks may still get
      // rebuilt shortly). Anything older that's unpaired is a real fail.
      const stuckTail = stats.unpaired.filter(
        (u) => walk.endBlock - u.blockNumber > MAX_PEOPLE_REBUILD_BLOCKS,
      );
      if (stuckTail.length > 0) {
        const oldest = stuckTail.reduce((a, b) =>
          a.blockNumber < b.blockNumber ? a : b,
        );
        const ageBlocks = walk.endBlock - oldest.blockNumber;
        const ageSec = ageBlocks * PEOPLE_BLOCK_SECONDS;
        throw new Error(
          `[ring-health] Ring builder STUCK on ${name} (${network.name}).\n` +
            `Effect: new attestations cannot generate ring-VRF proofs. ${stuckTail.length} attestation(s) have been waiting for a ring rebuild that never came — allowance claims, PGAS claims, statement-store writes, and bulletin uploads from those accounts will fail until the builder catches up.\n` +
            `Action: notify the individuality runtime team — this is a chain-side fault, NOT a test bug.\n` +
            `Numbers: ${stuckTail.length} unpaired Onboarded event(s); oldest at block ${oldest.blockNumber}, waiting ${ageBlocks} blocks (~${ageSec} s); healthy threshold is ${MAX_PEOPLE_REBUILD_BLOCKS} block(s).`,
        );
      }

      // Paired but slow: the rebuild happened, but with a gap past our
      // healthy threshold. Worth flagging — the chain is recovering but
      // user-facing latency is degraded.
      if (worst != null && worst > MAX_PEOPLE_REBUILD_BLOCKS) {
        const worstSec = worst * PEOPLE_BLOCK_SECONDS;
        const thresholdSec = MAX_PEOPLE_REBUILD_BLOCKS * PEOPLE_BLOCK_SECONDS;
        throw new Error(
          `[ring-health] Ring builder SLOW on ${name} (${network.name}) — degraded but recovering.\n` +
            `Effect: new attestations are eventually included, but with extended lag. Tests against freshly-attested accounts may pass on retry; real users will see longer-than-expected onboarding waits.\n` +
            `Action: monitor — if this fires across multiple health runs in a row, raise with the individuality runtime team. A single occurrence is usually a transient backlog and clears on its own.\n` +
            `Numbers: worst submit→rebuild latency was ${worst} blocks (~${worstSec} s); healthy threshold is ${MAX_PEOPLE_REBUILD_BLOCKS} block(s) (~${thresholdSec} s) — ${Math.round(worst / MAX_PEOPLE_REBUILD_BLOCKS)}× over budget.`,
        );
      }

      expect(true).toBe(true);
    });
  }
});
