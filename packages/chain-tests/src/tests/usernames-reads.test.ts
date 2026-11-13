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
import { Bytes } from "@polkadot-api/substrate-bindings";
import { fromHex } from "@polkadot-api/utils";
// Not resolvePeopleUsernameOwner (@internal): readPersonhoodState({ username }) reads the same entry.
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

/**
 * Returns the first key of `Resources.UsernameOwnerOf` at `hash`, decoded to the username
 * bytes, or undefined when the map is empty. The key is the entry's 32-byte prefix, then a
 * 16-byte Blake2_128 hash of the SCALE-encoded username (its compact length, then the bytes:
 * Blake2_128Concat). The prefix comes from the descriptor, and the username is checked by
 * rebuilding the key from it, so a different hasher or encoding fails here instead of
 * decoding a wrong name.
 */
async function firstRegisteredUsername(
  client: PolkadotClient,
  api: PeopleApi,
  hash: string,
): Promise<Uint8Array | undefined> {
  const entry = api.query.Resources.UsernameOwnerOf;
  const prefix = (await entry.getKey(new Uint8Array())).slice(0, 2 + 64);
  const [key] = await client._request<string[], [string, number, null, string]>(
    "state_getKeysPaged",
    [prefix, 1, null, hash],
  );
  if (key === undefined) return undefined;
  const username = Bytes().dec(fromHex(key).slice(32 + 16));
  if ((await entry.getKey(username)) !== key) {
    throw new Error("Resources.UsernameOwnerOf keys are not prefix, Blake2_128 hash, username");
  }
  return username;
}

describe("Username reads (product-sdk)", () => {
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

  // Reads one registered username with a paged raw key read at the finalized block. Its
  // owner and their usernames are read at the block readPersonhoodState pinned. The test
  // skips with a reason when the network has no registered username.
  it("reads a registered username back to its owner and their usernames", async (ctx) => {
    const { hash } = await peopleClient.getFinalizedBlock();
    const name = await firstRegisteredUsername(peopleClient, chain.individuality, hash);
    if (name === undefined) return ctx.skip(`no username is registered on ${getNetworkConfig().name}`);
    const username = new TextDecoder().decode(name);

    const personhood = await readPersonhoodState(chain, { username });
    if (!personhood.ok) throw personhood.error;
    if (personhood.value.tag === "UsernameUnowned") throw new Error("a registered username read as unowned");
    const at = personhood.value.at.blockHash;
    const owner = await chain.individuality.query.Resources.UsernameOwnerOf.getValue(name, { at });
    if (!owner) throw new Error("a registered username has no owner at the personhood block");
    expect(personhood.value.accountAddress).toBe(owner);

    const usernames = await lookupUsername(chain, { account: owner, at });
    if (!usernames.ok) throw usernames.error;
    expect([usernames.value?.liteUsername, usernames.value?.fullUsername]).toContain(username);
  });
});
