/**
 * Contract account mapping on a fork, as products reach it: `ensureContractAccountMapped` runs
 * before a product's first contract call. On these runtimes AutoMap maps an account when it is
 * created, and otherwise the call submits `Revive.map_account`. Either way a new account must end
 * up mapped, so a runtime that breaks either path fails here. Fork only, since it signs with //Alice.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, type PolkadotClient } from "polkadot-api";
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
async function waitUntil(description: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${description} timed out after ${WAIT_TIMEOUT_MS} ms`);
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
    const autoMap = await api.constants.Revive.AutoMap();
    const result = await ensureContractAccountMapped(runtime, fresh.address, fresh.signer);
    if (!result.ok) throw result.error;
    if (autoMap) {
      // AutoMap mapped the account when it was funded, so there is nothing to submit.
      expect(result.value).toBeNull();
    } else {
      if (!result.value) throw new Error("AutoMap is off, but no Revive.map_account was submitted");
      if (!result.value.ok) {
        throw new Error(`Revive.map_account failed: ${formatDispatchError(result.value)}`);
      }
    }
  });

  it("reads the fresh account as mapped, and a second ensureContractAccountMapped is a no-op", async () => {
    // The chain returns the address in its own SS58 format, so compare it re-encoded.
    await waitUntil("the mapping finalizes", async () => {
      const original = await api.query.Revive.OriginalAccount.getValue(ss58ToH160(fresh.address));
      return original !== undefined && AccountId().dec(AccountId().enc(original)) === fresh.address;
    });
    const result = await ensureContractAccountMapped(runtime, fresh.address, fresh.signer);
    if (!result.ok) throw result.error;
    expect(result.value).toBeNull();
  });
});
