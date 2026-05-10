import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient } from "polkadot-api";
import { createAssetHubClient, type AssetHubApi } from "../lib/client.js";
import { createTestAccount, type TestAccount } from "../lib/signer.js";
import { submitAndWatchBestBlock } from "../lib/tx.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

describe("Core: Asset Hub", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let api: AssetHubApi;
  let account: TestAccount;

  beforeAll(async () => {
    network = getNetworkConfig();
    console.log(`[core] Network: ${network.name}`);
    console.log(`[core] Asset Hub: ${network.assetHub.ws}`);

    const conn = createAssetHubClient(network.assetHub.ws);
    client = conn.client;
    api = conn.api;
    account = await createTestAccount();
    console.log(`[core] Test account: ${account.address}`);
  });

  afterAll(() => {
    client?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[core] Finalized block #${block.number} (${block.hash})`);

    expect(block.number).toBeGreaterThan(0);
    expect(block.hash).toBeTruthy();
  });

  it("test account is funded", async () => {
    const { data } = await api.query.System.Account.getValue(account.address);
    const freeDOT = Number(data.free) / 1e10;
    console.log(`[core] Balance: ${freeDOT.toFixed(4)} PAS (raw: ${data.free})`);

    expect(data.free).toBeGreaterThan(0n);
  });

  it("System.remark included in best block", async () => {
    const remark = Binary.fromText(`triangle-e2e-health-${Date.now()}`);
    const start = Date.now();

    const result = await submitAndWatchBestBlock(
      api.tx.System.remark({ remark }),
      account.signer,
    );
    const elapsed = Date.now() - start;

    console.log(`[core] Remark tx ok=${result.ok} block=#${result.block?.number} (${elapsed}ms)`);
    expect(result.ok).toBe(true);
  });
});
