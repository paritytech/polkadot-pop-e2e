/**
 * Web3 Storage on the networks that run it (`features.web3Storage`). A runtime upgrade can leave
 * storage the new runtime cannot decode; the chain keeps producing blocks, but the storage
 * provider no longer finds its own registration and stops serving. These tests fail on both.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWeb3StorageClient } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

const PROVIDER_READY_TIMEOUT_MS = 120_000;
const PROVIDER_POLL_MS = 5_000;

interface ProviderInfoResponse {
  provider_id: string;
  readiness: { provider_info_loaded: boolean };
}

async function readProviderInfo(provider: string): Promise<ProviderInfoResponse> {
  const response = await fetch(`${provider}/info`);
  if (!response.ok) throw new Error(`GET ${provider}/info: HTTP ${response.status}`);
  return (await response.json()) as ProviderInfoResponse;
}

const web3Storage = getNetworkConfig().web3Storage;

describe.skipIf(!web3Storage)("Web3 Storage", () => {
  let chain: ReturnType<typeof createWeb3StorageClient>;

  beforeAll(() => {
    assertChainHealthy("web3-storage");
    chain = createWeb3StorageClient(web3Storage!.ws);
  });

  afterAll(() => chain?.client.destroy());

  it("decodes every provider and bucket with the runtime the chain runs", async () => {
    const providers = await chain.api.query.StorageProvider.Providers.getEntries();
    const buckets = await chain.api.query.StorageProvider.Buckets.getEntries();
    console.log(`[web3-storage] ${providers.length} provider(s) and ${buckets.length} bucket(s) decode`);
    expect(providers.length).toBeGreaterThan(0);
  });

  it(
    "serves from a provider that has loaded its on-chain registration",
    async () => {
      const deadline = Date.now() + PROVIDER_READY_TIMEOUT_MS;
      let info = await readProviderInfo(web3Storage!.provider);
      while (!info.readiness.provider_info_loaded && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_POLL_MS));
        info = await readProviderInfo(web3Storage!.provider);
      }
      expect(info.readiness.provider_info_loaded).toBe(true);
      expect(await chain.api.query.StorageProvider.Providers.getValue(info.provider_id)).toBeDefined();
    },
    PROVIDER_READY_TIMEOUT_MS + 30_000,
  );
});
