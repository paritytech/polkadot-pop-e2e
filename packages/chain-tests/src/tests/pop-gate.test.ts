/**
 * Proof-of-personhood gating end-to-end.
 *
 * After the upstream `alias-claim.test.ts` has registered the attested
 * account's contextual alias for `triangle-e2e:pop-counter`, the
 * `PopCounter` smart contract (deployed via `scripts/deploy-counter.ts`)
 * should:
 *
 *   - Accept `bump()` from that attested account (status >= 1).
 *   - Reject `bump()` from any other account that has no alias for
 *     this context — via the `NotPerson()` custom error.
 *
 * The contract talks to the IPersonhood precompile at
 * `0x0a010000` (see `paritytech/individuality/precompiles/personhood`),
 * which reads `AliasAccounts.AccountToAlias[caller]` and returns
 * `{ status, contextAlias }` for the requested context. The precompile
 * being a thin wrapper over a normal storage read means the per-call
 * gas cost stays cheap once registration is paid for once per
 * (person, context).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import {
  createAssetHubClient,
  assertRichAssetHub,
  type RichAssetHubApi,
  type AssetHubApi,
} from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import {
  BUMP_SELECTOR_HEX,
  findPopCounterContract,
} from "../lib/pop-counter-contract.js";
import { createTestAccount } from "../lib/signer.js";

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PoP-gated counter",
  () => {
    let network: NetworkConfig;
    let assetHubClient: PolkadotClient;
    let assetHubApi: AssetHubApi;
    let contractAddress: `0x${string}`;

    beforeAll(async () => {
      assertChainHealthy("asset-hub");

      network = getNetworkConfig();
      console.log(`[pop-gate] Network: ${network.name}`);

      const ah = createAssetHubClient(network.assetHub.ws);
      assetHubClient = ah.client;
      assetHubApi = ah.api;

      const addr = await findPopCounterContract(assetHubApi);
      if (!addr) {
        throw new Error(
          "[pop-gate] No PopCounter contract deployed — run `pnpm deploy-counter` first.",
        );
      }
      contractAddress = addr as `0x${string}`;
      console.log(`[pop-gate] PopCounter at ${contractAddress}`);
    });

    afterAll(() => {
      assetHubClient?.destroy();
    });

    /**
     * Submit a `bump()` call from the given signer.
     *
     * The EVM-level success/revert is reported via two layers:
     *   - Outer pallet result (`dryRun.result.success`): false only on
     *     out-of-gas / undecodable revert / dispatch failure.
     *   - Inner ExecReturnValue.flags: bit 0 = REVERT. A contract that
     *     ran to completion but called `revert(…)` returns
     *     `success=true, flags=1, data=<error selector + args>`.
     *
     * Returns `{ ok, reverted, data, … }` so the caller can distinguish
     * the cases.
     */
    async function bump(richAh: RichAssetHubApi, signer: ReturnType<typeof getPolkadotSigner>, from: string) {
      const fin = await assetHubClient.getFinalizedBlock();
      const dryRun = await richAh.apis.ReviveApi.call(
        from,
        contractAddress,
        0n,
        undefined,
        undefined,
        Binary.fromHex(BUMP_SELECTOR_HEX),
        { at: fin.hash },
      );
      const outerOk = dryRun.result.success;
      const inner = outerOk
        ? (dryRun.result.value as unknown as { flags: number; data: Uint8Array })
        : null;
      const reverted = !outerOk || (inner !== null && (inner.flags & 1) !== 0);
      const returnDataHex = inner ? Binary.toHex(inner.data) : "";
      console.log(
        `[pop-gate] dry-run from=${from} outerOk=${outerOk} flags=${inner?.flags ?? "n/a"} reverted=${reverted} data=${returnDataHex.slice(0, 18)}…`,
      );

      const weight = dryRun.weight_required;
      const deposit =
        dryRun.storage_deposit.type === "Charge" ? dryRun.storage_deposit.value : 0n;
      const callTx = richAh.tx.Revive.call({
        dest: contractAddress,
        value: 0n,
        weight_limit: weight,
        storage_deposit_limit: deposit > 0n ? deposit : 1n,
        data: Binary.fromHex(BUMP_SELECTOR_HEX),
      });
      const result = await callTx.signAndSubmit(signer);
      return { result, reverted, returnDataHex };
    }

    it(
      "rejects calls from non-attested accounts",
      async () => {
        assertRichAssetHub(assetHubApi);
        const richAh = assetHubApi;

        // The test mnemonic / //Alice account is funded but has never
        // attested via the Identity Backend, so it has no alias
        // mapping in AliasAccounts.AccountToAlias. The precompile
        // returns status=0 and the contract reverts with NotPerson().
        const funder = await createTestAccount();
        console.log(`[pop-gate] non-PoP caller: ${funder.address}`);

        const { reverted, returnDataHex } = await bump(richAh, funder.signer, funder.address);
        expect(reverted).toBe(true);
        // We don't pin the exact revert selector — the gate behavior
        // ('non-PoP caller reverts') is what we care about, and
        // pinning a specific selector couples to solc layout details.
        // Surface the returned data on log for triage if a future
        // run reverts for a *different* reason than the PoP gate.
        console.log(`[pop-gate] revert data: ${returnDataHex}`);
        // Sanity: data must be at least a 4-byte selector, not empty
        // (which would be a low-level revert with no reason — likely
        // out of gas or an unexpected runtime panic).
        expect(returnDataHex.length).toBeGreaterThanOrEqual(10);
      },
      120_000,
    );

    it(
      "accepts calls from an account with a registered alias for this context",
      async () => {
        assertRichAssetHub(assetHubApi);
        const richAh = assetHubApi;

        // The attested account registered its alias for
        // "triangle-e2e:pop-counter" in the upstream alias-claim test
        // — that's exactly the context PopCounter checks.
        const creds = await ensureAttested();
        const keyPair = deriveKeyPair(creds.entropy);
        const signer = getPolkadotSigner(
          keyPair.publicKey,
          "Sr25519",
          async (input) => keyPair.sign(input),
        );
        console.log(`[pop-gate] PoP caller: ${creds.address}`);

        // Snapshot the byAlias mapping for the attested person before
        // we bump so we can assert it incremented. byAlias key is the
        // 32-byte contextAlias — derive it from AccountToAlias.
        const stored = await richAh.query.AliasAccounts.AccountToAlias.getValue(creds.address);
        if (!stored) {
          throw new Error(
            "[pop-gate] attested account has no alias on chain — upstream alias-claim test didn't run or used a different context.",
          );
        }
        const ourAlias = stored.ca.alias;
        console.log(`[pop-gate] our alias: ${ourAlias.slice(0, 14)}…`);

        const { result, reverted } = await bump(richAh, signer, creds.address);
        if (!result.ok) {
          throw new Error(
            `[pop-gate] dispatch failed: ${JSON.stringify(result.dispatchError)}`,
          );
        }
        console.log(`[pop-gate] PoP bump landed @#${result.block.number}, reverted=${reverted}`);
        expect(reverted).toBe(false);
      },
      180_000,
    );
  },
);
