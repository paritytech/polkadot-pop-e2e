/**
 * Personhood state and registration standing as product-sdk-individuality reads
 * them, so a runtime that drops or retypes something these reads touch fails here.
 * They only read, for a fresh account, so they need no attested account.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
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
});
