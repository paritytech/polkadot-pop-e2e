/**
 * Round-trip test for `AliasAccounts.set_alias_account` on Asset Hub.
 *
 * What we're testing: a Lite Person can register a 32-byte custom
 * `context` and the on-chain alias mapping comes back consistently
 * from both directions:
 *
 *   AccountToAlias[signer] = { ca: { alias, context }, ring, revision, collection }
 *   AliasToAccount[(LITE_PEOPLE, ContextualAlias{alias, context})] = signer
 *
 * The alias we observe on-chain must match what `verifiablejs.one_shot`
 * computed off-chain — that's the contract a downstream smart contract
 * (via the IPersonhood precompile) will rely on.
 *
 * Depends on:
 *   - `ensureAttested()` for the Lite Person credentials
 *   - the prior `allowances.test.ts` PGAS-claim run to mint enough
 *     PGAS to cover `AliasFee` (~1000 planck — trivial relative to
 *     one PgasClaimAmount = 50_000_000_000)
 *   - Asset Hub's `MembersSubscriber.RingRoots` window already
 *     carrying People's current ring revision (XCM-mirrored; usually
 *     true by the time the earlier PGAS test finished)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
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
import { assertRingBuilderHealthy } from "../lib/ring-cascade.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import { LITE_PEOPLE_IDENTIFIER } from "../lib/ring.js";
import {
  customAliasContext,
  setAliasAccount,
} from "../lib/alias-claim.js";
import { createTestAccount } from "../lib/signer.js";

// Same as `PopCounter.CTX` in contracts/PopCounter.sol — registering
// under this context here makes the attested account eligible to call
// `PopCounter.bump()` in the downstream `pop-gate.test.ts`. The
// alias-accounts pallet enforces one-alias-per-account, so sharing
// the context across the two tests is cheaper than re-attesting a
// fresh account just for the gate test.
const TEST_CONTEXT_LABEL = "triangle-e2e:pop-counter";

/**
 * Poll AH's RingRoots window until it carries the named revision.
 * Same race the PGAS test guards against — see allowances.test.ts'
 * `waitForAssetHubRing`. Local copy here so the alias test stays
 * standalone; if a third caller wants this we'll extract.
 */
async function waitForAhRingRevision(
  assetHubApi: RichAssetHubApi,
  collectionHex: string,
  ringIndex: number,
  targetRevision: number,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const pollMs = opts?.pollMs ?? 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const roots =
      (await assetHubApi.query.MembersSubscriber.RingRoots.getValue(
        collectionHex,
        ringIndex,
      )) ?? [];
    const max = roots.length === 0 ? -1 : Math.max(...roots.map((r) => r.revision));
    if (roots.some((r) => r.revision === targetRevision)) {
      console.log(
        `[alias-claim] AH ring sync OK: rev=${targetRevision} (max=${max}, window=${roots.length})`,
      );
      return;
    }
    console.log(
      `[alias-claim] waiting for AH ring sync — target rev=${targetRevision}, AH max=${max} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Asset Hub did not pick up People ring revision ${targetRevision} within ${timeoutMs / 1000}s`,
  );
}

describe.skipIf(!getNetworkConfig().features.pgas || !needsAttestation())(
  "Alias Accounts: paid registration round-trip",
  () => {
    let network: NetworkConfig;
    let peopleClient: PolkadotClient;
    let peopleApi: PeopleApi;
    let assetHubClient: PolkadotClient;
    let assetHubApi: AssetHubApi;

    beforeAll(async () => {
      assertChainHealthy("people");
      assertChainHealthy("asset-hub");
      assertRingBuilderHealthy();

      network = getNetworkConfig();
      console.log(`[alias-claim] Network: ${network.name}`);

      const peopleConn = createPeopleClient(network.people.ws);
      peopleClient = peopleConn.client;
      peopleApi = peopleConn.api;

      const ahConn = createAssetHubClient(network.assetHub.ws);
      assetHubClient = ahConn.client;
      assetHubApi = ahConn.api;
    });

    afterAll(() => {
      peopleClient?.destroy();
      assetHubClient?.destroy();
    });

    it(
      "register alias under a custom context and verify both directions",
      async () => {
        assertRichAssetHub(assetHubApi);
        const richAh = assetHubApi;

        const creds = await ensureAttested();
        console.log(`[alias-claim] Lite-person: ${creds.address} (${creds.username})`);

        // Top up the attested account with a little native PAS so it
        // can pay the outer tx fee. The dispatch-internal `AliasFee`
        // is still paid from PGAS (minted by the prior allowances
        // test). Revive's auto-PGAS routing doesn't apply to
        // non-Revive calls — so AliasAccounts needs native.
        // 100 PAS (10 decimals) covers many tx fees with margin.
        const NATIVE_TOPUP = 100_000_000_000n;
        const nativeBefore =
          (await richAh.query.System.Account.getValue(creds.address)).data.free;
        if (nativeBefore < NATIVE_TOPUP) {
          console.log(
            `[alias-claim] native balance ${nativeBefore} < ${NATIVE_TOPUP}, topping up from test account`,
          );
          const funder = await createTestAccount();
          const topupTx = richAh.tx.Balances.transfer_keep_alive({
            dest: { type: "Id" as const, value: creds.address },
            value: NATIVE_TOPUP,
          });
          const topupResult = await topupTx.signAndSubmit(funder.signer);
          if (!topupResult.ok) {
            throw new Error(
              `[alias-claim] funding transfer failed: ${JSON.stringify(topupResult.dispatchError)}`,
            );
          }
          console.log(`[alias-claim] topped up: block=#${topupResult.block.number}`);
        }

        // Fees come from the existing PGAS the allowances test minted.
        const PGAS_ASSET_ID = 2_000_000_000;
        const fee = await richAh.query.AliasAccounts.AliasFee.getValue();
        const balanceBefore =
          (await richAh.query.Assets.Account.getValue(PGAS_ASSET_ID, creds.address))?.balance ??
          0n;
        if (fee == null) {
          throw new Error(
            "[alias-claim] AliasAccounts.AliasFee is unset on this network — ops needs to call set_alias_fee before this test can run.",
          );
        }
        if (balanceBefore < fee) {
          throw new Error(
            `[alias-claim] PGAS balance ${balanceBefore} < AliasFee ${fee}; the prior PGAS claim test must mint enough.`,
          );
        }
        console.log(`[alias-claim] AliasFee=${fee} balance=${balanceBefore}`);

        const context = customAliasContext(TEST_CONTEXT_LABEL);
        const contextHex = Binary.toHex(context);

        // Read OUR ring's CURRENT revision from a fresh People-finalized
        // block and wait for AH to mirror it. We deliberately don't
        // reuse the cached `at` from Ring Inclusion: by the time this
        // test runs, the original revision is usually past the
        // pallet's `CleanupGracePeriod` and the runtime rejects with
        // `StaleRevision`. Proving against the *current* revision
        // dodges that.
        const idHex = Binary.toHex(LITE_PEOPLE_IDENTIFIER);
        const cached = await import("../lib/ring-cascade.js").then((m) =>
          m.getCachedRingLocation(),
        );
        if (!cached) {
          throw new Error(
            "[alias-claim] No cached ring location — Ring Inclusion probe didn't run.",
          );
        }
        const ourRingIndex = cached.ringIndex;
        const fin = await peopleClient.getFinalizedBlock();
        const peopleRoot = await peopleApi.query.Members.Root.getValue(
          idHex,
          ourRingIndex,
          { at: fin.hash },
        );
        const ourRingRev = peopleRoot?.revision ?? 0;
        console.log(
          `[alias-claim] our ring: index=${ourRingIndex} rev=${ourRingRev} (@${fin.hash.slice(0, 10)}…)`,
        );
        await waitForAhRingRevision(richAh, idHex, ourRingIndex, ourRingRev);

        // Register. The helper computes message = blake2_256(
        //   "alias-accounts" || account_pubkey || proof_valid_at_u64_LE),
        // generates the ring-VRF proof, and submits set_alias_account.
        const verifiableEntropy = blake2b256(creds.entropy);
        console.log(
          `[alias-claim] entropy=${Binary.toHex(verifiableEntropy).slice(0, 14)}… ctx=${contextHex.slice(0, 14)}…`,
        );

        const result = await setAliasAccount({
          peopleApi,
          peopleClient,
          assetHubApi: richAh,
          creds,
          context,
        });
        expect(result.ok).toBe(true);
        expect(result.alias.length).toBe(32);

        // Forward lookup: AccountToAlias[signer] must contain our alias.
        const stored = await richAh.query.AliasAccounts.AccountToAlias.getValue(creds.address);
        if (!stored) {
          throw new Error("[alias-claim] AccountToAlias missing after registration");
        }
        // PAPI 2.x serves SizedHex<32> as the raw `0x…` hex string —
        // no Binary wrapper to unwrap.
        const onChainAliasHex = stored.ca.alias;
        const expectedAliasHex = Binary.toHex(result.alias);
        const onChainContextHex = stored.ca.context;
        console.log(
          `[alias-claim] AccountToAlias: alias=${onChainAliasHex.slice(0, 14)}… ` +
            `context=${onChainContextHex.slice(0, 14)}… ring=${stored.ring} rev=${stored.revision}`,
        );
        expect(onChainAliasHex).toBe(expectedAliasHex);
        expect(onChainContextHex).toBe(contextHex);
        expect(stored.collection).toBe(idHex);

        // Reverse lookup: AliasToAccount[(LITE_PEOPLE, ContextualAlias)] == signer.
        // Compare by raw 32-byte pubkey (AccountId) rather than SS58, since
        // PAPI returns the address using the AH-runtime's SS58 prefix while
        // `creds.address` carries the default Substrate prefix — both
        // decode to the same underlying account.
        const { AccountId } = await import("polkadot-api");
        const accountIdCodec = AccountId();
        const reverseAccount = await richAh.query.AliasAccounts.AliasToAccount.getValue(
          idHex,
          { alias: stored.ca.alias, context: stored.ca.context },
        );
        console.log(`[alias-claim] AliasToAccount: ${reverseAccount ?? "(none)"}`);
        if (!reverseAccount) throw new Error("[alias-claim] reverse lookup missing");
        const reversePk = Binary.toHex(accountIdCodec.enc(reverseAccount));
        const credsPk = Binary.toHex(accountIdCodec.enc(creds.address));
        expect(reversePk).toBe(credsPk);

        const balanceAfter =
          (await richAh.query.Assets.Account.getValue(PGAS_ASSET_ID, creds.address))?.balance ??
          0n;
        const burned = balanceBefore - balanceAfter;
        console.log(`[alias-claim] PGAS ${balanceBefore} → ${balanceAfter} (burned=${burned})`);
        expect(burned).toBeGreaterThanOrEqual(fee);
      },
      // Setup + AH sync wait + claim finalization. PGAS test upstream
      // typically leaves AH already in sync, so most of this is the
      // single finalization round.
      180_000,
    );
  },
);
