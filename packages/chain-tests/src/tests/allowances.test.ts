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
 *   - statement.test.ts (StmtStore — daemon-granted on attestation)
 *   - storage.test.ts (LTS — claimed in beforeAll, then upload tests it)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import {
  createPeopleClient,
  createAssetHubClient,
  assertRichAssetHub,
  type PeopleApi,
  type RichAssetHubApi,
  type AssetHubApi,
} from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import {
  createClaimSigner,
  encodePgasClaim,
} from "../lib/claim-signer.js";
import {
  encodeMembers,
  fetchRingMembers,
  waitForInclusion,
} from "../lib/ring.js";
import { dayFromTimestamp, pgasContext } from "../lib/allowances.js";
import { findCounterContract } from "../lib/counter-contract.js";

/**
 * Pick a People-chain finalized block whose ring root for `ringIndex`
 * has already been mirrored to Asset Hub's `MembersSubscriber.RingRoots`
 * cache. The cache is a sliding window populated via XCM, so a brand-new
 * revision (e.g. just after a member onboarded) lags behind by tens of
 * seconds. Building a proof against a revision AH doesn't know yet
 * deterministically yields `BadProof`.
 */
async function waitForAssetHubRing(
  peopleApi: PeopleApi,
  peopleClient: PolkadotClient,
  assetHubApi: RichAssetHubApi,
  collectionHex: string,
  ringIndex: number,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 180_000; // up to 3 min for XCM
  const pollMs = opts?.pollMs ?? 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fin = await peopleClient.getFinalizedBlock();
    const peopleRoot = await peopleApi.query.Members.Root.getValue(collectionHex, ringIndex, {
      at: fin.hash,
    });
    const peopleRev = peopleRoot?.revision;
    if (peopleRev === undefined) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const ahRoots =
      (await assetHubApi.query.MembersSubscriber.RingRoots.getValue(collectionHex, ringIndex)) ?? [];
    const accepted = ahRoots.some((r) => r.revision === peopleRev);
    if (accepted) {
      console.log(
        `[pgas] AH RingRoots window has rev=${peopleRev} after ${Math.round((Date.now() - startedAt) / 1000)}s — submitting against People @${fin.hash.slice(0, 10)}…`,
      );
      return fin.hash;
    }
    const ahMax = ahRoots.length === 0 ? -1 : Math.max(...ahRoots.map((r) => r.revision));
    console.log(
      `[pgas] waiting for AH ring sync — people rev=${peopleRev}, AH window max rev=${ahMax} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Asset Hub did not catch up with People's ring revision within ${timeoutMs / 1000}s`,
  );
}

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "PGAS: claim + spend on revive",
() => {
  let network: NetworkConfig;
  let peopleClient: PolkadotClient;
  let peopleApi: PeopleApi;
  let assetHubClient: PolkadotClient;
  let assetHubApi: AssetHubApi;
  let verifiableEntropy: Uint8Array;
  let address: string;

  beforeAll(async () => {
    // Fail-fast off the chain-health probe if either chain we touch
    // here was already marked unhealthy — no point spending the 6-min
    // test budget hanging on RPC subscriptions to a sick node.
    assertChainHealthy("people");
    assertChainHealthy("asset-hub");

    network = getNetworkConfig();
    console.log(`[pgas] Network: ${network.name}`);

    const peopleConn = createPeopleClient(network.people.ws);
    peopleClient = peopleConn.client;
    peopleApi = peopleConn.api;

    const ahConn = createAssetHubClient(network.assetHub.ws);
    assetHubClient = ahConn.client;
    assetHubApi = ahConn.api;

    const creds = await ensureAttested();
    verifiableEntropy = blake2b256(creds.entropy);
    address = creds.address;
    console.log(`[pgas] Lite-person: ${address} (${creds.username})`);
  });

  afterAll(() => {
    peopleClient?.destroy();
    assetHubClient?.destroy();
  });

  it(
    "claim PGAS gas allowance (auto-sized to cover one Revive op)",
    async () => {
      // `features.pgas` gated this test; assert at the top so the rest of
      // the body sees `RichAssetHubApi` and reaches Pgas/MembersSubscriber
      // through real types instead of `any`.
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

      // PGAS lives on Asset Hub, but the lite-people ring is on People chain.
      // We fetch members from People (atomic snapshot at finalized block hash)
      // and submit the claim on Asset Hub.
      const location = await waitForInclusion(peopleApi, "LitePeople", verifiableEntropy, {
        peopleClient,
      });

      const PGAS_ASSET_ID = 2_000_000_000;
      const ringIndex = location.ringIndex;
      const nowSecs = Math.floor(Date.now() / 1000);
      const day = dayFromTimestamp(nowSecs);

      const ring = await import("../lib/ring.js");
      const idHex = Binary.toHex(ring.LITE_PEOPLE_IDENTIFIER);

      // Wait for Asset Hub's `MembersSubscriber.RingRoots` window to include
      // People's latest revision. AH receives ring roots from People via XCM;
      // on a freshly onboarded member there's a 30s–2min lag before the new
      // revision propagates. Submitting against a revision AH doesn't know
      // yet → BadProof. The same snapshot is reused for all claims so every
      // proof verifies against one stable (members, revision) pair.
      const at = await waitForAssetHubRing(
        peopleApi,
        peopleClient,
        assetHubApi,
        idHex,
        ringIndex,
      );
      const root = await peopleApi.query.Members.Root.getValue(idHex, ringIndex, { at });
      const revisionIndex = root?.revision ?? 0;
      const memberKeys = await fetchRingMembers(peopleApi, "LitePeople", ringIndex, at);
      const encodedMembers = encodeMembers(memberKeys);

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

      // Asset Hub's metadata-visible extensions on PGAS-capable runtimes are
      // AsPgas + AsRingAlias. Provide passthrough defaults; the per-claim
      // signer below overrides AsPgas with the proof-bearing payload.
      const customSignedExtensions = {
        AsPgas: { value: undefined },
        AsRingAlias: { value: undefined },
      };

      // Loop one claim per slot index 0..N-1. Each slot mints PgasClaimAmount
      // independently — they are separate claim records bound to distinct
      // (day, slot_index) contexts, so each needs its own ring-VRF proof.
      console.log(
        `[pgas] claiming ${slotsToClaim} slots — day=${day} ring=${ringIndex} rev=${revisionIndex} (people @${at.slice(0, 10)}…)`,
      );
      for (let slotIndex = 0; slotIndex < slotsToClaim; slotIndex++) {
        const context = pgasContext(day, slotIndex);
        const signer = createClaimSigner({
          extensionName: "AsPgas",
          context,
          verifiableEntropy,
          encodedMembers,
          encodeExtensionValue: (proof) =>
            encodePgasClaim({
              proof,
              ringIndex,
              revisionIndex,
              litePeople: true,
              day,
            }),
        });
        const tx = assetHubApi.tx.Pgas.claim_pgas({
          slot_index: slotIndex,
          target: address,
        });
        const result = await tx.signSubmitAndWatch(signer, { customSignedExtensions });
        const final = await new Promise<{ ok: boolean; block?: number }>(
          (resolve, reject) => {
            let last: { block?: number } = {};
            result.subscribe({
              next: (e: { type: string; ok?: boolean; block?: { number: number } }) => {
                if (e.block) last.block = e.block.number;
                if (e.type === "finalized") resolve({ ok: !!e.ok, block: last.block });
              },
              error: reject,
            });
          },
        );
        console.log(
          `[pgas] slot=${slotIndex} ok=${final.ok} block=#${final.block ?? "?"}`,
        );
        expect(final.ok).toBe(true);
      }

      const balanceAfter =
        (await assetHubApi.query.Assets.Account.getValue(PGAS_ASSET_ID, address))?.balance ??
        0n;
      const minted = balanceAfter - balanceBefore;
      console.log(
        `[pgas] balance: ${balanceBefore} → ${balanceAfter} (+${minted}, expected ≥${expectedMinMinted})`,
      );
      // Tolerate over-mint — a runtime upgrade bumping PgasClaimAmount mid-
      // run shouldn't fail health. We just need enough to spend.
      expect(minted).toBeGreaterThanOrEqual(expectedMinMinted);
    },
    // Tight bound: chain-health probe already shed slow-chain days
    // upstream (AH ring-roots lag check + per-chain liveness), so a
    // PGAS hang here is a real bug, not a degrading-chain symptom.
    // Setup ≈ 90-180s (waitForInclusion + ring stability + AH ring
    // sync) + up to ~30s for the claim tx. 180s fits under the
    // per-attempt retry budget (10 min) even when stacked with IB
    // setup (~60s) and the rest of the suite.
    180_000,
  );

  // Phase B: call a pre-deployed counter contract via revive, paying with
  // claimed PGAS. The contract is deployed out-of-band by
  // `scripts/deploy-counter.ts` (idempotent — runs in CI with //Alice).
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
      const keyPair = deriveKeyPair(creds.entropy);
      const signer = getPolkadotSigner(
        keyPair.publicKey,
        "Sr25519",
        async (input) => keyPair.sign(input),
      );

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
      const callResult = await callTx.signAndSubmit(signer);
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
