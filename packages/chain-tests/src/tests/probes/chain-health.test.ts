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
import { markChainUnhealthy } from "../../lib/chain-cascade.js";
import { LITE_PEOPLE_IDENTIFIER } from "../../lib/ring.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";

// Block-production threshold. A healthy chain produces a finalized
// block within seconds; if `getFinalizedBlock()` itself takes longer
// than this, the WS subscription isn't seeing chainHead events at all.
const FINALIZED_BLOCK_PROBE_MS = 15_000;

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
        const block = await peopleClient.getFinalizedBlock();
        console.log(`[chain-health] People finalized #${block.number} (${block.hash.slice(0, 10)}…)`);
        expect(block.number).toBeGreaterThan(0);
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
        const block = await assetHubClient.getFinalizedBlock();
        console.log(`[chain-health] Asset Hub finalized #${block.number} (${block.hash.slice(0, 10)}…)`);
        expect(block.number).toBeGreaterThan(0);
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
        const block = await bulletinClient.getFinalizedBlock();
        console.log(`[chain-health] Bulletin finalized #${block.number} (${block.hash.slice(0, 10)}…)`);
        expect(block.number).toBeGreaterThan(0);
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
