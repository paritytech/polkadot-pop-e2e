/**
 * Finds the freshly attested account's place in the LitePeople ring and caches
 * it in `ring-cascade`, so the feature suites (PGAS, LTS, alias) read it via
 * `getCachedRingLocation()` instead of each waiting for inclusion.
 *
 * truapi-host attest has already seen the account in a ring, so a miss here
 * on a finalizing chain means the locally derived ring key no longer matches truapi's.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { createPeopleClient, type PeopleApi } from "../../lib/client.js";
import { ensureAttested, needsAttestation } from "../../lib/attested-fixture.js";
import { assertChainHealthy } from "../../lib/chain-cascade.js";
import { setCachedRingLocation } from "../../lib/ring-cascade.js";
import { waitForInclusion } from "../../lib/ring.js";
import { getNetworkConfig, type NetworkConfig } from "../../config/networks.js";
import { personRingEntropy } from "../../lib/truapi-identity.js";

// truapi-host attest has already seen the account in a ring, so only the
// finality and stability reads remain.
const INCLUSION_WAIT_MS = 120_000;
const RING_INCLUSION_TIMEOUT_MS = INCLUSION_WAIT_MS + 60_000;

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
      assertChainHealthy("people");

      network = getNetworkConfig();
      console.log(`[ring-inclusion] Network: ${network.name}`);
      console.log(`[ring-inclusion] People: ${network.people.ws}`);

      const conn = createPeopleClient(network.people.ws);
      peopleClient = conn.client;
      peopleApi = conn.api;

      const creds = await ensureAttested();
      verifiableEntropy = personRingEntropy(creds);
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
        const location = await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, {
          peopleClient,
          timeoutMs: INCLUSION_WAIT_MS,
        }).catch((err: Error) => {
          if (!err.message.includes("Ring inclusion timed out")) throw err;
          err.message +=
            `\n\ntruapi-host attest already saw ${address} in a personhood ring. If People ` +
            "finality is moving, the LitePeople key truapi-identity.ts derives is out of step with truapi.";
          throw err;
        });
        setCachedRingLocation(location);
        console.log(
          `[ring-inclusion] OK — account included at ring=${location.ringIndex} page=${location.ringPage} pos=${location.ringPosition} @${location.at.slice(0, 10)}…`,
        );
      },
      RING_INCLUSION_TIMEOUT_MS,
    );
  },
);
