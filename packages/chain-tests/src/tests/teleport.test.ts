/**
 * The relay's native token arrives on Asset Hub by teleport: the path users take to move funds
 * from the relay to the chain where they spend them. Signs on the relay with the test account and
 * waits for the balance to arrive on an account derived from it on Asset Hub.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import { toHex } from "@polkadot-api/utils";
import {
  XcmV3MultiassetFungibility,
  XcmV3WeightLimit,
  XcmV5Junction,
  XcmV5Junctions,
  XcmVersionedAssets,
  XcmVersionedLocation,
} from "@pop-e2e/papi";
import { createRelayClient, createSystemAssetHubClient, type RelayApi, type SystemAssetHubApi } from "../lib/client.js";
import { createTestAccount } from "../lib/signer.js";
import { submitFinalized } from "../lib/finalized-tx.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

const ARRIVAL_TIMEOUT_MS = 180_000;

describe.skipIf(!getNetworkConfig().features.systemFlows)("Teleport: relay → Asset Hub", () => {
  let relayClient: PolkadotClient;
  let relayApi: RelayApi;
  let assetHubClient: PolkadotClient;
  let assetHubApi: SystemAssetHubApi;

  beforeAll(() => {
    assertChainHealthy("asset-hub");
    const network = getNetworkConfig();
    const relay = network.relay!;
    console.log(`[teleport] Network: ${network.name}`);
    console.log(`[teleport] Relay: ${relay.ws}`);
    console.log(`[teleport] Asset Hub: ${network.assetHub.ws}`);
    ({ client: relayClient, api: relayApi } = createRelayClient(relay.ws));
    ({ client: assetHubClient, api: assetHubApi } = createSystemAssetHubClient(network.assetHub.ws));
  });

  afterAll(() => {
    relayClient?.destroy();
    assetHubClient?.destroy();
  });

  it(
    "teleports the native token from the relay and it arrives on Asset Hub",
    async () => {
      const sender = await createTestAccount();
      const beneficiary = await createTestAccount("//pop-e2e-teleport");
      const amount = 10n * (await relayApi.constants.Balances.ExistentialDeposit());
      const assetHubParaId = await assetHubApi.query.ParachainInfo.ParachainId.getValue();
      const previousBalance = (await assetHubApi.query.System.Account.getValue(beneficiary.address)).data.free;

      const result = await submitFinalized(
        relayApi.tx.XcmPallet.limited_teleport_assets({
          dest: XcmVersionedLocation.V5({
            parents: 0,
            interior: XcmV5Junctions.X1(XcmV5Junction.Parachain(assetHubParaId)),
          }),
          beneficiary: XcmVersionedLocation.V5({
            parents: 0,
            interior: XcmV5Junctions.X1(
              XcmV5Junction.AccountId32({ network: undefined, id: toHex(beneficiary.signer.publicKey) }),
            ),
          }),
          assets: XcmVersionedAssets.V5([
            { id: { parents: 0, interior: XcmV5Junctions.Here() }, fun: XcmV3MultiassetFungibility.Fungible(amount) },
          ]),
          fee_asset_item: 0,
          weight_limit: XcmV3WeightLimit.Unlimited(),
        }),
        sender.signer,
      );
      const [{ payload: attemptEvent }] = relayApi.event.XcmPallet.Attempted.filter(result.events);
      expect(attemptEvent.outcome.type).toBe("Complete");
      console.log(`[teleport] Sent ${amount} to ${beneficiary.address} in relay block #${result.block.number}`);

      const startTimestamp = Date.now();
      let subscription: { unsubscribe(): void } | undefined;
      let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
      const arrivalBalance = await new Promise<bigint>((resolve, reject) => {
        subscription = assetHubApi.query.System.Account.watchValue(beneficiary.address, { at: "finalized" }).subscribe({
          next: ({ value }) => value.data.free > previousBalance && resolve(value.data.free),
          error: reject,
        });
        arrivalTimer = setTimeout(
          () => reject(new Error(`the teleport didn't arrive on Asset Hub within ${ARRIVAL_TIMEOUT_MS / 1000}s`)),
          ARRIVAL_TIMEOUT_MS,
        );
      }).finally(() => {
        subscription?.unsubscribe();
        clearTimeout(arrivalTimer);
      });
      console.log(`[teleport] Arrived on Asset Hub after ${Math.round((Date.now() - startTimestamp) / 1000)}s: ${arrivalBalance - previousBalance}`);
      // Asset Hub takes its execution fee out of the teleported amount.
      expect(arrivalBalance - previousBalance).toBeLessThanOrEqual(amount);
    },
    ARRIVAL_TIMEOUT_MS + 120_000,
  );
});
