/**
 * Game airdrop event ids, read through product-sdk-individuality. The SDK takes
 * the id base from the `Game.airdrop_event_id_base` constant, so a runtime that
 * drops it breaks every draw lookup.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import { fromPapi, readGameAirdropEventIds } from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

describe("Game airdrops", () => {
  let peopleClient: PolkadotClient;
  let chain: ReturnType<typeof fromPapi<PeopleApi, PolkadotClient>>;

  beforeAll(() => {
    assertChainHealthy("people");
    const { client, api } = createPeopleClient(getNetworkConfig().people.ws);
    peopleClient = client;
    chain = fromPapi(client, api);
  });

  afterAll(() => {
    peopleClient?.destroy();
  });

  it("derives a game's airdrop event ids from the chain's base", async () => {
    const result = await readGameAirdropEventIds(chain, { gameIndex: 0, airdropsScheduled: 1 });
    if (!result.ok) {
      const cause = result.error.cause instanceof Error ? `: ${result.error.cause.message}` : "";
      throw new Error(`${result.error.message}${cause}`);
    }
    expect(result.value).toHaveLength(1);
  });
});
