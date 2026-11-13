/**
 * Personhood state and registration standing as product-sdk-individuality reads
 * them, so a runtime that drops or retypes something these reads touch fails here.
 * They only read, so they need no attested account. The last one reads an enrolled
 * participant when the network has one.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { fromHex } from "@polkadot-api/utils";
import {
  fromPapi,
  readPersonhoodState,
  readRegistrationEligibility,
  watchParticipant,
  type PapiIndividualityChain,
  type PersonhoodParticipant,
} from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

describe("Personhood reads (product-sdk)", () => {
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

  // Reads the account's alias, lite record, Score participant and the personhood
  // threshold at one block. An account no pallet knows is NotEnrolled.
  it("reads the personhood state of an account that never enrolled", async () => {
    const read = await readPersonhoodState(chain, { account: accountAddress });
    if (!read.ok) throw read.error;
    if (read.value.tag === "UsernameUnowned") throw new Error("an account read never looks up a username");
    expect(read.value.state.tag).toBe("NotEnrolled");
  });

  // Reads Score.Participants and Score.PersonhoodThreshold, which Score.register checks.
  it("reads the registration standing of an account Score never saw", async () => {
    const read = await readRegistrationEligibility(chain, {
      registrant: { tag: "Account", accountAddress },
    });
    if (!read.ok) throw read.error;
    expect(read.value.participant).toBeNull();
    expect(read.value.readyToRegister).toBe(false);
  });

  // Follows Score.Participants the way a product shows a player's progress live.
  it("watches the Score participant of an account Score never saw", async () => {
    const first = await new Promise<PersonhoodParticipant | null>((resolve, reject) => {
      let stop: (() => void) | undefined;
      let done = false;
      const timer = setTimeout(() => finish(() => reject(new Error("no value within 60 s"))), 60_000);
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop?.();
        settle();
      };
      stop = watchParticipant(
        chain,
        { player: { type: "Account", value: accountAddress } },
        (participant) => finish(() => resolve(participant)),
        (error) => finish(() => reject(error)),
      );
      if (done) stop();
    });
    expect(first).toBeNull();
  });

  // Reads the first Score.Participants key with a paged raw read at the finalized block. The
  // key is the entry's 32-byte prefix, a 16-byte Blake2_128 hash, then the SCALE AccountOrPerson
  // (variant byte, then 32 bytes). A Person key or an empty map skips with a reason.
  it("reads the personhood state of an enrolled participant", async (ctx) => {
    const { hash } = await peopleClient.getFinalizedBlock();
    const entry = chain.individuality.query.Score.Participants;
    const prefix = (await entry.getKey({ type: "Account", value: accountAddress })).slice(0, 2 + 64);
    const [key] = await peopleClient._request<string[], [string, number, null, string]>(
      "state_getKeysPaged",
      [prefix, 1, null, hash],
    );
    if (key === undefined) return ctx.skip(`no participant is recorded on ${getNetworkConfig().name}`);
    const body = fromHex(key).slice(32 + 16);
    if (body[0] !== 0) return ctx.skip(`the first participant on ${getNetworkConfig().name} is keyed by Person`);
    const account = AccountId().dec(body.slice(1));
    if ((await entry.getKey({ type: "Account", value: account })) !== key) {
      throw new Error("Score.Participants keys are not prefix, Blake2_128 hash, AccountOrPerson");
    }

    const personhood = await readPersonhoodState(chain, { account });
    if (!personhood.ok) throw personhood.error;
    if (personhood.value.tag === "UsernameUnowned") throw new Error("an account read never looks up a username");
    expect(personhood.value.state.tag).not.toBe("NotEnrolled");

    const eligibility = await readRegistrationEligibility(chain, {
      registrant: { tag: "Account", accountAddress: account },
    });
    if (!eligibility.ok) throw eligibility.error;
    expect(eligibility.value.participant).not.toBeNull();
  });
});
