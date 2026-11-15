/**
 * Contract account mapping on a fork, as products reach it: `ensureContractAccountMapped` runs
 * before a product's first contract call. On these runtimes AutoMap maps an account when it is
 * created, and otherwise the call submits `Revive.map_account`. Either way a new account must end
 * up mapped, so a runtime that breaks either path fails here. Fork only, since it signs with //Alice.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import { formatDispatchError } from "@parity/product-sdk-tx";
import {
  createContractRuntimeFromClient,
  ensureContractAccountMapped,
  type ContractRuntime,
} from "@parity/product-sdk-contracts";
import { ss58ToH160 } from "@parity/product-sdk/address";
import { createAssetHubClient, descriptorsForNetwork, type AssetHubApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { createTestAccount } from "../lib/signer.js";
import {
  createFreshSr25519Account,
  fundAccount,
  POLL_MS,
  sleep,
  type FreshAccount,
} from "../lib/fork-account.js";
import { getNetworkConfig } from "../config/networks.js";

const WAIT_TIMEOUT_MS = 3 * 60_000;

/** Polls `check` until it holds, or fails after `WAIT_TIMEOUT_MS`. */
async function waitUntil(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} did not hold within ${WAIT_TIMEOUT_MS} ms`);
    await sleep(POLL_MS);
  }
}

describe.skipIf(!getNetworkConfig().testAccountUri)("Contract account mapping flow (product-sdk)", () => {
  let client: PolkadotClient;
  let api: AssetHubApi;
  let runtime: ContractRuntime;
  let fresh: FreshAccount;

  beforeAll(async () => {
    assertChainHealthy("asset-hub");
    ({ client, api } = createAssetHubClient(getNetworkConfig().assetHub.ws));
    runtime = createContractRuntimeFromClient(client, descriptorsForNetwork().assetHub);
    fresh = createFreshSr25519Account();
    // The deposit covers the map_account deposit when AutoMap is off, and the rest pays fees.
    const amount =
      (await api.constants.Revive.DepositPerItem()) * 10n +
      (await api.constants.Balances.ExistentialDeposit());
    await fundAccount(api, (await createTestAccount()).signer, fresh.address, amount);
    // The mapping reads below are finalized. AutoMap maps the account in its funding block, so
    // wait for that block to finalize, or the first ensure would see it unmapped and submit map_account.
    await waitUntil("the funding finalizes", async () => {
      const { data } = await api.query.System.Account.getValue(fresh.address);
      return data.free >= amount;
    });
  });

  afterAll(() => {
    client?.destroy();
  });

  it("maps the fresh account through ensureContractAccountMapped", async () => {
    const result = await ensureContractAccountMapped(runtime, fresh.address, fresh.signer);
    if (!result.ok) throw result.error;
    if (result.value && !result.value.ok) {
      throw new Error(`Revive.map_account failed: ${formatDispatchError(result.value)}`);
    }
    const path = result.value ? "Revive.map_account" : "AutoMap on creation";
    console.log(`[map-account-flow] ${fresh.address} mapped via ${path}`);
  });

  it("reads the fresh account as mapped in Revive.OriginalAccount", async () => {
    await waitUntil("the mapping finalizes", async () =>
      (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(fresh.address))) === fresh.address,
    );
  });

  it("treats a second ensureContractAccountMapped as a no-op", async () => {
    const result = await ensureContractAccountMapped(runtime, fresh.address, fresh.signer);
    if (!result.ok) throw result.error;
    expect(result.value).toBeNull();
  });
});
