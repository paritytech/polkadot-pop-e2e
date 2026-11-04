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
  const registrant = { tag: "Account", accountAddress: AccountId().dec(randomBytes(32)) } as const;
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

  // Reads Game.airdrop_event_id_base whether or not a game is running. An id is 32
  // bytes only while the base keeps its 27.
  it("derives a 32-byte event id per scheduled draw", async () => {
    const ids = await readGameAirdropEventIds(chain, { gameIndex: 1, airdropsScheduled: 2 });
    if (!ids.ok) throw ids.error;
    expect(ids.value).toHaveLength(2);
    for (const id of ids.value) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // The SDK returns an error naming the entry when the runtime no longer serves it.
  it("reads the sign-up requirement of an account that never played", async () => {
    const read = await readGameSignUpRequirement(chain, { registrant });
    if (!read.ok) throw read.error;
  });

  // A game given by the caller reads its draws, their entropy and their winners even
  // when no game is running or the running one scheduled none.
  it("reads the draws and winners of a past game", async () => {
    const status = await readPrizeStatus(chain, {
      game: { index: 1, airdropsScheduled: 2 },
      registrant,
    });
    if (!status.ok) throw status.error;
  });
});
