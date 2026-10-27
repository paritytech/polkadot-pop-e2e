/**
 * PGAS gas-allowance flow + a smart-contract call paid in PGAS via
 * `pallet-revive`. Only runs on networks where `features.pgas` is true.
 *
 * The two tests are tightly coupled: the claim mints PGAS to the lite-
 * person, and the revive call spends it. They share state so we keep
 * them in one file.
 *
 * NOTE: The Statement Store and LongTermStorage allowance claims used
 * to live here too. They are now exercised implicitly by:
 *   - statement.test.ts (StmtStore — claimed for the product key that then publishes)
 *   - storage.test.ts (LTS — claimed in beforeAll, then upload tests it)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { createAssetHubClient, assertRichAssetHub, type AssetHubApi } from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import { createPgasPayerSigner } from "../lib/claim-signer.js";
import { findCounterContract } from "../lib/counter-contract.js";
import { personKey } from "../lib/truapi-identity.js";
import { claimPgas } from "../lib/truapi-host.js";

// Every claim shares the budget left after the finalized balance wait, so
// a slow claim fails with the CLI's error rather than vitest's timeout.
const PGAS_TEST_TIMEOUT_MS = 420_000;
const BALANCE_WAIT_MS = 120_000;

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PGAS: claim + spend on revive",
() => {
  let network: NetworkConfig;
  let assetHubClient: PolkadotClient;
  let assetHubApi: AssetHubApi;
  let mnemonic: string;
  let publicKey: Uint8Array;
  let address: string;

  beforeAll(async () => {
    // Fail-fast off the chain-health probe if either chain we touch
    // here was already marked unhealthy — no point spending the 6-min
    // test budget hanging on RPC subscriptions to a sick node.
    assertChainHealthy("people");
    assertChainHealthy("asset-hub");

    network = getNetworkConfig();
    console.log(`[pgas] Network: ${network.name}`);

    const ahConn = createAssetHubClient(network.assetHub.ws);
    assetHubClient = ahConn.client;
    assetHubApi = ahConn.api;

    const creds = await ensureAttested();
    mnemonic = creds.mnemonic;
    publicKey = creds.publicKey;
    address = creds.address;
    console.log(`[pgas] Lite-person: ${address} (${creds.username})`);
  });

  afterAll(() => {
    assetHubClient?.destroy();
  });

  it(
    "claim PGAS gas allowance (auto-sized to cover one Revive op)",
    async () => {
      // `features.pgas` gated this test, so Asset Hub carries Pgas.
      assertRichAssetHub(assetHubApi);

      // We need at least enough PGAS to cover one minimum Revive op (one new
      // child-trie storage item): `DepositPerChildTrieItem + bytes ×
      // DepositPerByte = 200_000_000 + 64 × 100_000 = 206_400_000`.
      const MIN_PGAS_FOR_ONE_OP = 206_400_000n;

      // Per-claim mint amount is read from chain — adapts automatically to
      // runtime upgrades. Number of claims is ceil(MIN / per-claim). Capped
      // at 10 to fail fast if PgasClaimAmount has regressed to something
      // pathologically small rather than burn time on dozens of claims.
      const pgasPerClaim = await assetHubApi.constants.Pgas.PgasClaimAmount();
      const slotsToClaim = Number(
        (MIN_PGAS_FOR_ONE_OP + pgasPerClaim - 1n) / pgasPerClaim,
      );
      if (slotsToClaim > 10) {
        throw new Error(
          `[pgas] PgasClaimAmount (${pgasPerClaim}) is suspiciously low — ` +
            `would need ${slotsToClaim} claims to cover ${MIN_PGAS_FOR_ONE_OP} PGAS for one Revive op`,
        );
      }
      const expectedMinMinted = pgasPerClaim * BigInt(slotsToClaim);
      console.log(
        `[pgas] PgasClaimAmount=${pgasPerClaim}, slots=${slotsToClaim}, expect ≥${expectedMinMinted}`,
      );

      const PGAS_ASSET_ID = 2_000_000_000;

      // Confirm PGAS asset is created — without it, claim would dispatch but
      // the mint would fail. (Failure here means ops still need to submit
      // Pgas.create_pgas_asset.)
      const pgasAsset = await assetHubApi.query.Assets.Asset.getValue(PGAS_ASSET_ID);
      if (!pgasAsset) {
        throw new Error(
          `PGAS asset (id ${PGAS_ASSET_ID}) does not exist on Asset Hub — ` +
            `ops needs to submit Pgas.create_pgas_asset (permissionless authorized).`,
        );
      }
      const balanceBefore =
        (await assetHubApi.query.Assets.Account.getValue(PGAS_ASSET_ID, address))?.balance ??
        0n;

      // truapi-host claims the day's first free slot on each call, as hosts do.
      const claimDeadline = Date.now() + PGAS_TEST_TIMEOUT_MS - BALANCE_WAIT_MS - 30_000;
      for (let claim = 0; claim < slotsToClaim; claim++) {
        const output = await claimPgas(mnemonic, publicKey, claimDeadline);
        console.log(`[pgas] truapi-host pgas-check (${claim + 1}/${slotsToClaim}):\n${output.trim()}`);
      }

      // truapi-host returns once the claims are in a block; the balance is read
      // at finalized, so wait for it to catch up.
      const pgasBalance = async () =>
        (await assetHubApi.query.Assets.Account.getValue(PGAS_ASSET_ID, address))?.balance ?? 0n;
      let balanceAfter = await pgasBalance();
      for (const deadline = Date.now() + BALANCE_WAIT_MS; Date.now() < deadline; ) {
        if (balanceAfter - balanceBefore >= expectedMinMinted) break;
        await new Promise((r) => setTimeout(r, 6_000));
        balanceAfter = await pgasBalance();
      }
      const minted = balanceAfter - balanceBefore;
      console.log(
        `[pgas] balance: ${balanceBefore} → ${balanceAfter} (+${minted}, expected ≥${expectedMinMinted})`,
      );
      // Tolerate over-mint — a runtime upgrade bumping PgasClaimAmount mid-
      // run shouldn't fail health. We just need enough to spend.
      expect(minted).toBeGreaterThanOrEqual(expectedMinMinted);
    },
    PGAS_TEST_TIMEOUT_MS,
  );

  // Phase B: call a pre-deployed counter contract via revive, paying with
  // claimed PGAS. The contract is deployed out-of-band by
  // `scripts/deploy-counter.ts` (idempotent — runs in CI before the suite).
  //
  // Fee charging: `ChargePGAS<ChargeAssetTxPayment>` is a runtime-wide
  // tx extension on Asset Hub. For `RuntimeCall::Revive(..)` it auto-
  // detects PGAS balance and charges in PGAS — no `asset:` option needed
  // (that's the inner ChargeAssetTxPayment fallback for non-revive calls).
  it(
    "call counter contract via revive, paying with claimed PGAS",
    async () => {
      const PGAS_ASSET_ID = 2_000_000_000;

      const contract = await findCounterContract(assetHubApi);
      if (!contract) {
        throw new Error(
          "[pgas] No counter contract deployed — run `pnpm tsx scripts/deploy-counter.ts` first.",
        );
      }
      console.log(`[pgas] revive: targeting counter at ${contract}`);

      const balanceBefore =
        (await assetHubApi.query.Assets.Account.getValue(PGAS_ASSET_ID, address))?.balance ??
        0n;
      // Claim test sizes its slots to cover the ~206M storage deposit for
      // one new child-trie storage item with margin. If we see less than
      // that here, the claim half regressed and the failure mode below would
      // be StorageDepositNotEnoughFunds.
      const MIN_PGAS_FOR_ONE_OP = 206_400_000n;
      if (balanceBefore < MIN_PGAS_FOR_ONE_OP) {
        throw new Error(
          `[pgas] insufficient PGAS to spend: have ${balanceBefore}, need ≥${MIN_PGAS_FOR_ONE_OP}. ` +
            `The prior claim test must run first and mint enough.`,
        );
      }
      console.log(`[pgas] revive: PGAS balance before = ${balanceBefore}`);

      const infoBefore = await assetHubApi.query.Revive.AccountInfoOf.getValue(contract);
      const itemsBefore =
        infoBefore?.account_type?.type === "Contract"
          ? infoBefore.account_type.value.storage_items
          : 0;

      // Build sr25519 signer from the attestation entropy — same key the
      // claim test used, so it owns the PGAS we just minted.
      const creds = await ensureAttested();
      const keyPair = personKey(creds);
      const signer = createPgasPayerSigner(keyPair);

      // Dry-run via ReviveApi.call to get exact weight + storage deposit.
      // Validate-time fee is computed against `weight_limit`; passing the
      // worst-case here would overshoot our PGAS balance and ChargePGAS
      // would skip PGAS → fall to native → InvalidTransaction::Payment.
      //
      // Pass an explicit `{ at }` — PAPI 2.1.2 misclassifies the empty
      // `Binary.fromHex("0x")` last arg as the options object (vacuous
      // `[].every()` in `isOptionalArg`), which binds `at` to
      // `Uint8Array.prototype.at` (a function) and crashes the chainHead
      // pipeline. See docs/issues/papi-isOptionalArg-misclassifies-empty-binary.md.
      const finForDryRun = await assetHubClient.getFinalizedBlock();
      const dryRun = await assetHubApi.apis.ReviveApi.call(
        address,
        contract,
        0n,
        undefined,
        undefined,
        Binary.fromHex("0x"),
        { at: finForDryRun.hash },
      );
      if (dryRun.result.success === false) {
        throw new Error(
          `[pgas] dry-run failed: ${JSON.stringify(dryRun.result.value)}`,
        );
      }
      const weightRequired = dryRun.weight_required;
      const storageDeposit =
        dryRun.storage_deposit.type === "Charge" ? dryRun.storage_deposit.value : 0n;
      console.log(
        `[pgas] revive: dry-run weight ref_time=${weightRequired.ref_time} proof_size=${weightRequired.proof_size} storage_deposit=${storageDeposit}`,
      );

      const callTx = assetHubApi.tx.Revive.call({
        dest: contract,
        value: 0n,
        weight_limit: weightRequired,
        storage_deposit_limit: storageDeposit > 0n ? storageDeposit : 1n,
        data: Binary.fromHex("0x"),
      });
      const callResult = await callTx.createAndSubmit(signer, {
        customSignedExtensions: { RestrictOrigins: { value: false } },
      });
      if (!callResult.ok) {
        throw new Error(
          `[pgas] revive call failed: dispatchError=${JSON.stringify(callResult.dispatchError)}`,
        );
      }
      console.log(`[pgas] revive: contract call ok block=#${callResult.block.number}`);

      const infoAfter = await assetHubApi.query.Revive.AccountInfoOf.getValue(contract);
      const itemsAfter =
        infoAfter?.account_type?.type === "Contract"
          ? infoAfter.account_type.value.storage_items
          : -1;
      console.log(`[pgas] revive: storage_items ${itemsBefore} → ${itemsAfter}`);

      const balanceAfter =
        (await assetHubApi.query.Assets.Account.getValue(PGAS_ASSET_ID, address))?.balance ??
        0n;
      const fee = balanceBefore - balanceAfter;
      console.log(`[pgas] revive: PGAS ${balanceBefore} → ${balanceAfter} (fee=${fee})`);
      expect(fee).toBeGreaterThan(0n);
      // storage_items only increments on the FIRST SSTORE to a new slot.
      // Once slot 0 is touched, subsequent calls only update its value,
      // not the count. So a "no-change" outcome is fine — what proves
      // dispatch is the PGAS fee deduction above.
      expect(itemsAfter).toBeGreaterThanOrEqual(itemsBefore);
    },
    300_000,
  );
},
);
