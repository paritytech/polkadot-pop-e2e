/**
 * The bind leg of the DIM2 lite sign-up, built by product-sdk-individuality:
 * read the chain's score context, bind the attested lite person's alias to a
 * product account with `buildLiteAliasBindTx`, and check the binding landed.
 *
 * The ring-VRF proof is the host's job, so `createProof` stands in for the
 * host with verifiablejs over the live LitePeople ring.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, Binary, type PolkadotClient } from "polkadot-api";
import {
  buildLiteAliasBindTx,
  fromPapi,
  readScoreContext,
  type CreateRingVRFProof,
  type LiteAliasBindChain,
  type NetworkSuffixChain,
  type ScoreContextChain,
} from "@parity/product-sdk-individuality";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getCachedRingLocation } from "../lib/ring-cascade.js";
import {
  encodeMembers,
  fetchRingMembers,
  LITE_PEOPLE_IDENTIFIER,
  ringExponent,
  waitForInclusion,
} from "../lib/ring.js";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { getNetworkConfig } from "../config/networks.js";
import { personRingEntropy } from "../lib/truapi-identity.js";

describe.skipIf(!getNetworkConfig().features.resources || !needsAttestation())(
  "Lite sign-up: bind alias to a product account",
  () => {
    let peopleClient: PolkadotClient;
    let peopleApi: PeopleApi;
    let chain: ReturnType<typeof fromPapi<PeopleApi, PolkadotClient>>;

    beforeAll(() => {
      assertChainHealthy("people");
      ({ client: peopleClient, api: peopleApi } = createPeopleClient(getNetworkConfig().people.ws));
      chain = fromPapi(peopleClient, peopleApi);
    });

    afterAll(() => {
      peopleClient?.destroy();
    });

    /** What a host's `createRingVRFProof` returns, minted locally for `context`. */
    async function liteProver(context: Uint8Array): Promise<CreateRingVRFProof> {
      const creds = await ensureAttested();
      const entropy = personRingEntropy(creds);
      const { ringIndex } =
        getCachedRingLocation() ??
        (await waitForInclusion(peopleApi, "LitePeople", entropy, { peopleClient }));
      const exponent = await ringExponent(peopleApi, "LitePeople");
      return async (message) => {
        const at = (await peopleClient.getFinalizedBlock()).hash;
        const root = await peopleApi.query.Members.Root.getValue(
          Binary.toHex(LITE_PEOPLE_IDENTIFIER),
          ringIndex,
          { at },
        );
        const members = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
        const { proof, alias } = verifiableFor().one_shot(exponent, entropy, encodeMembers(members), context, message);
        return {
          proof,
          contextualAlias: { context, alias },
          ringIndex,
          ringRevision: root?.revision ?? 0,
        };
      };
    }

    it(
      "binds the lite alias in the chain's score context",
      async () => {
        const score = await readScoreContext(chain as unknown as ScoreContextChain & NetworkSuffixChain);
        if (!score.ok) throw score.error;
        console.log(`[lite-bind] score context ${score.value.tag} ${score.value.productId}`);
        expect(score.value.tag).toBe("ProductDerived");

        const account = AccountId().dec(crypto.getRandomValues(new Uint8Array(32)));
        const { transaction } = await buildLiteAliasBindTx(chain as unknown as LiteAliasBindChain, {
          account,
          createProof: await liteProver(score.value.context),
        });
        const result = await peopleClient.submit(transaction);
        expect(result.ok).toBe(true);

        const binding = await peopleApi.query.PeopleLite.AccountToAlias.getValue(account);
        console.log(`[lite-bind] ${account} bound at #${result.block.number}`);
        expect(binding?.ca.context).toBe(Binary.toHex(score.value.context));
      },
      180_000,
    );
  },
);
