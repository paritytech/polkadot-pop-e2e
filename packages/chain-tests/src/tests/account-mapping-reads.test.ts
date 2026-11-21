/**
 * Revive account mapping as product-sdk-contracts' isContractAccountMapped reads it from
 * Revive.OriginalAccount. The tests only read.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { xxhashAsHex } from "@polkadot/util-crypto";
import {
  createContractRuntimeFromClient,
  isContractAccountMapped,
  type ContractRuntime,
} from "@parity/product-sdk-contracts";
import { ss58ToH160 } from "@parity/product-sdk/address";
import { createAssetHubClient, descriptorsForNetwork, type AssetHubApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig, networkKey } from "../config/networks.js";

// twox128("Revive") ++ twox128("OriginalAccount"): every key of the map starts with this.
const ORIGINAL_ACCOUNT_PREFIX =
  xxhashAsHex("Revive", 128) + xxhashAsHex("OriginalAccount", 128).slice(2);

describe("Account mapping reads (product-sdk)", () => {
  let client: PolkadotClient;
  let api: AssetHubApi;
  let runtime: ContractRuntime;

  beforeAll(() => {
    assertChainHealthy("asset-hub");
    ({ client, api } = createAssetHubClient(getNetworkConfig().assetHub.ws));
    runtime = createContractRuntimeFromClient(client, descriptorsForNetwork().assetHub);
  });

  afterAll(() => {
    client?.destroy();
  });

  it("reports a fresh random account as not mapped", async () => {
    const randomAccount = AccountId().dec(randomBytes(32));
    const result = await isContractAccountMapped(runtime, randomAccount);
    if (!result.ok) throw result.error;
    expect(result.value).toBe(false);
  });

  // Reads one key of the map through the raw `state_getKeysPaged` call, so no full scan is
  // needed. The key ends with the H160 (Identity hasher on this runtime; the trailing 20 bytes
  // are the H160 under any hasher that appends the key), which is then read with getValue.
  // The key and its value are both read at one finalized block (`at`), so they cannot disagree.
  it("reports an account with an OriginalAccount entry as mapped", async (ctx) => {
    const { hash: at } = await client.getFinalizedBlock();
    const [key] = await client._request<string[], [string, number, null, string]>(
      "state_getKeysPaged",
      [ORIGINAL_ACCOUNT_PREFIX, 1, null, at],
    );
    if (!key) {
      ctx.skip(`Revive.OriginalAccount is empty on ${networkKey()}`);
      return;
    }
    const h160 = `0x${key.slice(-40)}` as const;

    const mappedAccount = await api.query.Revive.OriginalAccount.getValue(h160, { at });
    if (!mappedAccount) throw new Error(`OriginalAccount key ${key} has no value on ${networkKey()}`);
    expect(ss58ToH160(mappedAccount).toLowerCase()).toBe(h160.toLowerCase());

    const result = await isContractAccountMapped(runtime, mappedAccount);
    if (!result.ok) throw result.error;
    expect(result.value).toBe(true);
  });
});
