import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import { createContractRuntimeFromClient, type ContractRuntime } from "@parity/product-sdk-contracts";
import { resolveDotNs } from "@parity/product-sdk/identity";
import { createAssetHubClient, descriptorsForNetwork } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

describe.skipIf(!getNetworkConfig().features.dotns)("DotNS: name resolution on Asset Hub", () => {
  let client: PolkadotClient;
  let runtime: ContractRuntime;

  beforeAll(() => {
    assertChainHealthy("asset-hub");
    ({ client } = createAssetHubClient(getNetworkConfig().assetHub.ws));
    runtime = createContractRuntimeFromClient(client, descriptorsForNetwork().assetHub, {
      at: "finalized",
    });
  });

  afterAll(() => {
    client?.destroy();
  });

  it("resolves a registered product name to its owner", async () => {
    const result = await resolveDotNs("host-playground", { runtime });
    if (!result.ok) throw result.error;
    console.log(`[dotns] ${result.value?.name} owner=${result.value?.owner}`);
    expect(result.value?.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("resolves an unregistered name to null", async () => {
    const result = await resolveDotNs(`pop-e2e-unregistered-${Date.now()}`, { runtime });
    if (!result.ok) throw result.error;
    expect(result.value).toBeNull();
  });
});
