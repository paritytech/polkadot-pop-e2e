/**
 * product-sdk's person-origin signers, used as products wrap their account
 * signer. A remark is not a call these origins exist for; the check is that
 * the released wrappers still sign on this runtime. Replace each with its real
 * flow once one can run here (game sign-up needs a game in registration).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import { submitAndWatch } from "@parity/product-sdk-tx";
import {
  withAsPerson,
  withLiteAlias,
  withScoreParticipant,
} from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { createTestAccount, type TestAccount } from "../lib/signer.js";
import { getNetworkConfig } from "../config/networks.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";

const ORIGIN_SIGNERS: Record<string, (signer: PolkadotSigner) => PolkadotSigner> = {
  withAsPerson: (signer) => withAsPerson(signer, { tag: "AliasWithAccount" }),
  withLiteAlias: (signer) => withLiteAlias(signer, { tag: "AliasWithAccount" }),
  withScoreParticipant: (signer) => withScoreParticipant(signer),
};

describe("Person-origin signers: released product-sdk", () => {
  let peopleClient: PolkadotClient;
  let peopleApi: PeopleApi;
  let account: TestAccount;

  beforeAll(async () => {
    assertChainHealthy("people");
    const network = getNetworkConfig();
    ({ client: peopleClient, api: peopleApi } = createPeopleClient(network.people.ws));
    account = await createTestAccount();
  });

  afterAll(() => {
    peopleClient?.destroy();
  });

  for (const [name, wrap] of Object.entries(ORIGIN_SIGNERS)) {
    it(`submits a People transaction signed with ${name}`, async () => {
      const remark = Binary.fromText(`pop-e2e-consumer-${name}-${Date.now()}`);
      const result = await submitAndWatch(
        peopleApi.tx.System.remark({ remark }),
        wrap(account.signer),
      );
      if (!result.ok) throw result.error;
      expect(result.value.ok).toBe(true);
    });
  }
});
