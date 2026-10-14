/**
 * Proof-of-personhood gating end-to-end.
 *
 * After the upstream `alias-claim.test.ts` has registered the attested
 * account's contextual alias for `triangle-e2e:pop-counter`, the
 * `PopCounter` smart contract (deployed via `scripts/deploy-counter.ts`)
 * should:
 *
 *   - Accept `bump()` from that attested account.
 *   - Reject `bump()` from any other account that has no alias for
 *     this context — via the `NotPerson()` custom error.
 *
 * The contract talks to the IPersonhood precompile at
 * `0x0a010000` (see `paritytech/individuality/precompiles/personhood`),
 * which reads `AliasAccounts.AccountToAlias[caller]`. Calls go through
 * product-sdk-contracts, as a product's would.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { createAssetHubClient, assertRichAssetHub, type AssetHubApi } from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { createPgasPayerSigner } from "../lib/claim-signer.js";
import { getNetworkConfig } from "../config/networks.js";
import { connectPopCounter, revertName } from "../lib/pop-counter-contract.js";

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PoP-gated counter",
  () => {
    let assetHubClient: PolkadotClient;
    let assetHubApi: AssetHubApi;
    let counter: Awaited<ReturnType<typeof connectPopCounter>>["contract"];

    beforeAll(async () => {
      assertChainHealthy("asset-hub");
      const network = getNetworkConfig();
      ({ client: assetHubClient, api: assetHubApi } = createAssetHubClient(network.assetHub.ws));
      const popCounter = await connectPopCounter(assetHubClient);
      counter = popCounter.contract;
      console.log(`[pop-gate] PopCounter at ${popCounter.address}`);
    });

    afterAll(() => {
      assetHubClient?.destroy();
    });

    it(
      "rejects calls from non-attested accounts",
      async () => {
        // A fresh account has no alias in AliasAccounts.AccountToAlias.
        const origin = AccountId().dec(crypto.getRandomValues(new Uint8Array(32)));
        const result = await counter.bump.query({ origin });
        console.log(`[pop-gate] non-PoP caller ${origin}: ${revertName(result)}`);
        expect(revertName(result)).toBe("NotPerson");
      },
      120_000,
    );

    it(
      "accepts calls from an account with a registered alias for this context",
      async () => {
        assertRichAssetHub(assetHubApi);
        // The upstream alias-claim test registered this account's alias for
        // "triangle-e2e:pop-counter", the context PopCounter checks.
        const creds = await ensureAttested();
        const stored = await assetHubApi.query.AliasAccounts.AccountToAlias.getValue(creds.address);
        if (!stored) {
          throw new Error(
            "[pop-gate] attested account has no alias on chain — upstream alias-claim test didn't run or used a different context.",
          );
        }

        const query = await counter.bump.query({ origin: creds.address });
        expect(revertName(query)).toBeUndefined();

        const result = await counter.bump.tx({
          signer: createPgasPayerSigner(deriveKeyPair(creds.entropy)),
          origin: creds.address,
        });
        if (!result.ok) throw result.error;
        console.log(`[pop-gate] PoP bump landed @#${result.value.block.number}`);
        expect(result.value.ok).toBe(true);
      },
      180_000,
    );
  },
);
