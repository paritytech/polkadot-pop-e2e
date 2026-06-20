/**
 * Per-account ring-inclusion probe. Runs after the Identity Backend has
 * registered our fresh test account (status = ASSIGNED) but BEFORE any
 * feature suite that needs that account included in the lite-people
 * ring on the People chain (PGAS claim, LTS allowance, Statement Store).
 *
 * Why this is its own test rather than baked into each feature suite:
 *
 * Before this probe existed, every feature suite called `waitForInclusion`
 * itself, inside its `it()` body. A stuck ring builder meant the FIRST
 * feature suite (PGAS, alphabetically) hit its own outer test-timeout
 * before `waitForInclusion`'s richer chain-side diagnostic could print —
 * the matrix message then showed `✗ PGAS: claim + spend on revive →
 * Test timed out in 180000ms`, attributing a chain-side fault to PGAS.
 * The on-call would read that and reach for the PGAS pallet docs, not
 * the individuality runtime team.
 *
 * Now `waitForInclusion` happens once under THIS probe's name. When the
 * builder is stuck, the failing test in the matrix message reads
 * `✗ Ring Inclusion > freshly attested account is Included in
 * LitePeople ring → Ring inclusion timed out … chain-side fault, NOT a
 * test bug. Notify the individuality runtime team.` Feature suites still
 * fail (they ran, after all) but with `[ring-cascade]` attribution
 * pointing back here. Right team gets paged.
 *
 * On success we cache the `MemberLocation` in `ring-cascade` so the
 * feature suites read ring/page/position via `getCachedRingLocation()`
 * instead of paying the inclusion wait a second time.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { createPeopleClient, type PeopleApi } from "../../lib/client.js";
import { ensureAttested, needsAttestation } from "../../lib/attested-fixture.js";
import { assertChainHealthy } from "../../lib/chain-cascade.js";
import { setCachedRingLocation } from "../../lib/ring-cascade.js";
import { waitForInclusion } from "../../lib/ring.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";

// Outer test budget. Must exceed `waitForInclusion`'s internal default
// (300 s) by enough headroom that vitest doesn't kill the test mid-poll
// — when it does, the rich `formatInclusionTimeout` verdict gets
// swallowed and we're back to the "Test timed out" message that buried
// chain-side attribution in the first place. 360 s = 300 s budget + 60 s
// slack for the People client + IB attestation reuse.
const RING_INCLUSION_TIMEOUT_MS = 360_000;

describe.skipIf(!needsAttestation())(
  "Ring Inclusion",
  () => {
    let network: NetworkConfig;
    let peopleClient: PolkadotClient;
    let peopleApi: PeopleApi;
    let verifiableEntropy: Uint8Array;
    let address: string;
    let username: string;

    beforeAll(async () => {
      // Chain-health probe verdict short-circuits us if People is dead —
      // no point waiting 5 min for a ring rebuild on a chain that isn't
      // producing finalized blocks at all.
      assertChainHealthy("people");

      network = getNetworkConfig();
      console.log(`[ring-inclusion] Network: ${network.name}`);
      console.log(`[ring-inclusion] People: ${network.people.ws}`);

      const conn = createPeopleClient(network.people.ws);
      peopleClient = conn.client;
      peopleApi = conn.api;

      const creds = await ensureAttested();
      verifiableEntropy = blake2b256(creds.entropy);
      address = creds.address;
      username = creds.username;
      console.log(`[ring-inclusion] Lite-person: ${address} (${username})`);
    });

    afterAll(() => {
      peopleClient?.destroy();
    });

    it(
      "freshly attested account is Included in LitePeople ring",
      async () => {
        // `waitForInclusion` carries its own ~5-min budget and on timeout
        // throws `formatInclusionTimeout` — a verbose, on-call-readable
        // verdict that already classifies the failure into chain-side
        // vs backend-side and tells the reader which team to notify.
        const location = await waitForInclusion(
          peopleApi,
          "LitePeople",
          verifiableEntropy,
          { peopleClient },
        );
        setCachedRingLocation(location);
        console.log(
          `[ring-inclusion] OK — account included at ring=${location.ringIndex} page=${location.ringPage} pos=${location.ringPosition} @${location.at.slice(0, 10)}…`,
        );
      },
      RING_INCLUSION_TIMEOUT_MS,
    );
  },
);
