/**
 * Game sign-up, draws and prizes as product-sdk-individuality reads them, so a
 * runtime that drops or retypes something the Game sign-up reads fails here. These
 * only read, so they need no attested account.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import {
  fromPapi,
  readGameAirdropEventIds,
  readGameSignUpRequirement,
  readPrizeStatus,
  type PapiIndividualityChain,
} from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

describe.skipIf(!getNetworkConfig().features.game)("Game sign-up reads (product-sdk)", () => {
  let peopleClient: PolkadotClient;
  let chain: PapiIndividualityChain<PeopleApi, PolkadotClient>;

  beforeAll(() => {
    assertChainHealthy("people");
    const people = createPeopleClient(getNetworkConfig().people.ws);
    peopleClient = people.client;
    chain = fromPapi(people.client, people.api);
  });

  afterAll(() => {
    peopleClient?.destroy();
  });

  // Reads Game.airdrop_event_id_base whether or not a game is running.
  it("derives one 32-byte event id per scheduled draw", async () => {
    const ids = await readGameAirdropEventIds(chain, { gameIndex: 1, airdropsScheduled: 2 });
    if (!ids.ok) throw ids.error;
    expect(ids.value).toHaveLength(2);
    expect(new Set(ids.value).size).toBe(2);
    for (const id of ids.value) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("reads the sign-up requirement of an account that never played", async () => {
    const accountAddress = AccountId().dec(randomBytes(32));
    const read = await readGameSignUpRequirement(chain, { registrant: { tag: "Account", accountAddress } });
    if (!read.ok) throw read.error;
    const requirement = read.value;
    if (requirement.gameIndex === null) {
      expect(requirement.blockers).toEqual([{ tag: "NoGameRunning" }]);
      return;
    }
    expect(requirement.variant).toBe("Account");
    expect(requirement.eventIds).toHaveLength(requirement.airdropsScheduled);
    expect(requirement.blockers).not.toContainEqual({ tag: "AlreadyRegistered" });
  });

  it("reads the current draws without naming a registrant", async () => {
    const status = await readPrizeStatus(chain);
    if (!status.ok) throw status.error;
    if (status.value.tag === "NoGame") return;
    expect(status.value.drawCountFrom).toBe("chain");
    expect(status.value.draws).toHaveLength(status.value.game?.airdropsScheduled ?? 0);
  });
});
