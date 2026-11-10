/**
 * Contract account mapping as product-sdk reads it. `isAccountMapped` (product-sdk-tx) is a
 * wrapper: it asks the MappingChecker it is given. Here that checker is built on
 * `isContractAccountMapped` (product-sdk-contracts), the same way `ensureContractAccountMapped`
 * builds it. The storage read of `Revive.OriginalAccount` (keyed by the H160 of the SS58
 * account) is `isContractAccountMapped`'s, so a runtime that drops or retypes that storage
 * fails here. Both functions only read; nothing is signed or submitted.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
import { xxhashAsHex } from "@polkadot/util-crypto";
import { isAccountMapped, type MappingChecker } from "@parity/product-sdk-tx";
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
  let checker: MappingChecker;

  beforeAll(() => {
    assertChainHealthy("asset-hub");
    const conn = createAssetHubClient(getNetworkConfig().assetHub.ws);
    client = conn.client;
    api = conn.api;
    runtime = createContractRuntimeFromClient(client, descriptorsForNetwork().assetHub);
    checker = {
      addressIsMapped: async (address) => {
        const mapped = await isContractAccountMapped(runtime, address);
        if (!mapped.ok) throw mapped.error;
        return mapped.value;
      },
    };
  });

  afterAll(() => {
    client?.destroy();
  });

  it("reports a fresh random account as not mapped", async () => {
    const fresh = AccountId().dec(randomBytes(32));

    expect(await isAccountMapped(fresh, checker)).toBe(false);

    const contract = await isContractAccountMapped(runtime, fresh);
    if (!contract.ok) throw contract.error;
    expect(contract.value).toBe(false);
  });

  // Reads one key of the map through the raw `state_getKeysPaged` call, so no full scan is
  // needed. The key ends with the H160 (Identity hasher on this runtime; the trailing 20 bytes
  // are the H160 under any hasher that appends the key), which is then read with getValue.
  it("reports an account with an OriginalAccount entry as mapped", async (ctx) => {
    const [key] = await client._request<string[], [string, number]>("state_getKeysPaged", [
      ORIGINAL_ACCOUNT_PREFIX,
      1,
    ]);
    if (!key) {
      ctx.skip(`Revive.OriginalAccount is empty on ${networkKey()}`);
      return;
    }
    expect(key.startsWith(ORIGINAL_ACCOUNT_PREFIX)).toBe(true);
    const h160 = `0x${key.slice(-40)}` as const;

    const mapped = await api.query.Revive.OriginalAccount.getValue(h160);
    if (!mapped) throw new Error(`OriginalAccount key ${key} has no value on ${networkKey()}`);
    expect(ss58ToH160(mapped).toLowerCase()).toBe(h160.toLowerCase());

    expect(await isAccountMapped(mapped, checker)).toBe(true);

    const contract = await isContractAccountMapped(runtime, mapped);
    if (!contract.ok) throw contract.error;
    expect(contract.value).toBe(true);
  });
});
