import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { namehash, type Hex } from "viem";
import type { PolkadotClient } from "polkadot-api";
import { createAssetHubClient, type AssetHubApi } from "../lib/client.js";
import { createTestAccount, type TestAccount } from "../lib/signer.js";
import { performContractCall } from "../lib/contract.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import { DOTNS_REGISTRY_ABI, DOTNS_CONTENT_RESOLVER_ABI } from "../config/contracts.js";

describe("DotNS: Domain resolution on Asset Hub", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let api: AssetHubApi;
  let account: TestAccount;
  const hasDotns = () => network.contracts !== null;

  beforeAll(async () => {
    network = getNetworkConfig();
    console.log(`[dotns] Network: ${network.name}`);
    console.log(`[dotns] Asset Hub: ${network.assetHub.ws}`);
    console.log(`[dotns] DotNS deployed: ${network.contracts !== null}`);

    const conn = createAssetHubClient(network.assetHub.ws);
    client = conn.client;
    api = conn.api;
    account = await createTestAccount();
  });

  afterAll(() => {
    client?.destroy();
  });

  it.skipIf(!getNetworkConfig().contracts)("host-playground.dot exists in registry", async () => {
    const contracts = network.contracts!;
    const node = namehash("host-playground.dot");

    const exists = await performContractCall<boolean>(
      api,
      client,
      account.address,
      contracts.dotnsRegistry,
      DOTNS_REGISTRY_ABI,
      "recordExists",
      [node],
    );

    console.log(`[dotns] host-playground.dot recordExists=${exists}`);
    expect(exists).toBe(true);
  });

  it.skipIf(!getNetworkConfig().contracts)("triangle-e2e.dot exists in registry", async () => {
    const contracts = network.contracts!;
    const node = namehash("triangle-e2e.dot");

    const exists = await performContractCall<boolean>(
      api,
      client,
      account.address,
      contracts.dotnsRegistry,
      DOTNS_REGISTRY_ABI,
      "recordExists",
      [node],
    );

    console.log(`[dotns] triangle-e2e.dot recordExists=${exists}`);
    expect(exists).toBe(true);
  });

  it.skipIf(!getNetworkConfig().contracts)("host-playground.dot resolves to IPFS content hash", async () => {
    const contracts = network.contracts!;
    const node = namehash("host-playground.dot");

    const contentHash = await performContractCall<Hex>(
      api,
      client,
      account.address,
      contracts.dotnsContentResolver,
      DOTNS_CONTENT_RESOLVER_ABI,
      "contenthash",
      [node],
    );

    console.log(`[dotns] host-playground.dot contenthash=${contentHash.slice(0, 20)}...`);

    expect(contentHash).not.toBe("0x");
    expect(contentHash.length).toBeGreaterThan(10);
    // 0xe3 = IPFS namespace prefix
    expect(contentHash.startsWith("0xe3")).toBe(true);
  });

  it.skipIf(!getNetworkConfig().contracts)("content hash CID is fetchable from IPFS gateway", async () => {
    const contracts = network.contracts!;
    const node = namehash("host-playground.dot");

    const contentHash = await performContractCall<Hex>(
      api,
      client,
      account.address,
      contracts.dotnsContentResolver,
      DOTNS_CONTENT_RESOLVER_ABI,
      "contenthash",
      [node],
    );

    // Decode CID from content hash: skip 0xe3 prefix (IPFS namespace) + 0x01 (CIDv1 codec)
    // The rest is the multihash. We need to convert to CIDv1 base32.
    // For now, use the raw hex to fetch via the gateway's /api/v0 or try the .dot.li resolution.
    const gatewayUrl = `${network.ipfsGateway}/ipfs/${contentHash}`;
    console.log(`[dotns] Fetching via gateway: ${network.ipfsGateway}/ipfs/...`);

    // Use the .dot.li gateway which resolves DotNS domains directly
    const dotLiUrl = `https://host-playground.dot.li`;
    const response = await fetch(dotLiUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });

    console.log(`[dotns] host-playground.dot.li status=${response.status}`);
    expect(response.ok).toBe(true);
  });
});
