/**
 * People usernames (Resources) as product-sdk-individuality reads them: the account to
 * usernames direction (`Resources.Consumers`), the personhood read of a username nobody
 * owns (`Resources.UsernameOwnerOf`), and the owner of one registered username. A runtime
 * that drops or retypes either storage entry fails here. These only read, for a fresh
 * account and a fresh name, so they need no attested account.
 */
import { randomBytes, randomInt } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import {
  fromPapi,
  lookupUsername,
  readPersonhoodState,
  type PapiIndividualityChain,
} from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

/** A random lowercase label, so no chain holds it. */
function randomLabel(): string {
  return Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
}

/** A random People username in the shape the chain stores: a label, a dot and two digits. */
function randomUsername(): string {
  return `${randomLabel()}.${String(randomInt(100)).padStart(2, "0")}`;
}

describe.skipIf(!getNetworkConfig().features.game)("Username reads (product-sdk)", () => {
  const accountAddress = AccountId().dec(randomBytes(32));
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

  // Reads Resources.Consumers for the account. An account with no consumer record is
  // an answer, not a failure, so the read resolves to null.
  it("reads the usernames of an account that never registered one", async () => {
    const read = await lookupUsername(chain, { account: accountAddress });
    if (!read.ok) throw read.error;
    expect(read.value).toBeNull();
  });

  // Reads Resources.UsernameOwnerOf for a name nobody registered. The username resolves
  // to UsernameUnowned on the ok channel, not to an error.
  it("reads the personhood state of an unowned username as UsernameUnowned", async () => {
    const read = await readPersonhoodState(chain, { username: randomUsername() });
    if (!read.ok) throw read.error;
    expect(read.value.tag).toBe("UsernameUnowned");
  });

  // Takes the first Resources.UsernameOwnerOf key at the finalized block.
  it("reads a registered username back to its owner and their usernames", async (ctx) => {
    const { hash } = await peopleClient.getFinalizedBlock();
    const metadata = unifyMetadata(decAnyMetadata(await peopleClient.getMetadata(hash)));
    const keys = getDynamicBuilder(getLookupFn(metadata)).buildStorage("Resources", "UsernameOwnerOf").keys;
    const [key] = await peopleClient._request<string[], [string, number, null, string]>(
      "state_getKeysPaged",
      [keys.enc(), 1, null, hash],
    );
    if (key === undefined) return ctx.skip(`no username is registered on ${getNetworkConfig().name}`);
    const username = new TextDecoder().decode(keys.dec(key)[0]);

    const personhood = await readPersonhoodState(chain, { username });
    if (!personhood.ok) throw personhood.error;
    if (personhood.value.tag === "UsernameUnowned") throw new Error("a registered username read as unowned");
    const at = personhood.value.at.blockHash;

    const usernames = await lookupUsername(chain, { account: personhood.value.accountAddress, at });
    if (!usernames.ok) throw usernames.error;
    expect([usernames.value?.liteUsername, usernames.value?.fullUsername]).toContain(username);
  });
});
