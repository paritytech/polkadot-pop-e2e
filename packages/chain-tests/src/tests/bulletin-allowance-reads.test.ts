/**
 * Bulletin allowance status as product-sdk-cloud-storage reads it, so a runtime that
 * drops or retypes `TransactionStorage.Authorizations` fails here before a product's
 * pre-flight check does. Read-only: no signed extrinsic, no upload, no attested account.
 *
 * Each test pins its reads to one finalized block. `getBulletinAllowanceStatus` takes no
 * block option, so the typed api is wrapped to pass `{ at }` to the two storage reads it
 * makes. The discovered entry is then compared with the SDK result from the same block.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AccountId, Binary, type PolkadotClient } from "polkadot-api";
import { xxhashAsHex } from "@polkadot/util-crypto";
import { getBulletinAllowanceStatus, type CloudStorageApi } from "@parity/product-sdk-cloud-storage";
import { createBulletinClient, type BulletinApi } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig, networkKey } from "../config/networks.js";

type AuthorizationKey = Parameters<BulletinApi["query"]["TransactionStorage"]["Authorizations"]["getValue"]>[0];

// twox128("TransactionStorage") ++ twox128("Authorizations"): every key of the map starts with this.
const AUTHORIZATIONS_PREFIX =
  xxhashAsHex("TransactionStorage", 128) + xxhashAsHex("Authorizations", 128).slice(2);

/** The two reads `getBulletinAllowanceStatus` makes, each forced to the block `at`. */
function pinnedTo(api: BulletinApi, at: string): CloudStorageApi {
  return {
    query: {
      System: {
        Number: { getValue: () => api.query.System.Number.getValue({ at }) },
      },
      TransactionStorage: {
        Authorizations: {
          getValue: (key: AuthorizationKey) =>
            api.query.TransactionStorage.Authorizations.getValue(key, { at }),
        },
      },
    },
  } as unknown as CloudStorageApi;
}

describe("Bulletin allowance reads (product-sdk)", () => {
  let client: PolkadotClient;
  let api: BulletinApi;

  beforeAll(() => {
    assertChainHealthy("bulletin");
    ({ client, api } = createBulletinClient(getNetworkConfig().bulletin.ws));
  });

  afterAll(() => {
    client?.destroy();
  });

  // A fresh 32-byte account has never been authorized, so the SDK returns its
  // documented "no allowance" state: every quota field zero, expiry at block 0,
  // and `usable` false.
  it("reports a fresh account as having no allowance", async () => {
    const finalized = await client.getFinalizedBlock();
    const address = AccountId().dec(randomBytes(32));
    const status = await getBulletinAllowanceStatus(pinnedTo(api, finalized.hash), address);
    if (!status.ok) throw status.error;
    expect(status.value).toEqual({
      authorized: false,
      remainingTransactions: 0,
      remainingBytes: 0n,
      expiration: 0,
      remainingBlocks: 0,
      usable: false,
    });
  });

  // Picks the first Account-scoped entry in `Authorizations` at a pinned finalized block.
  // The SDK result is checked against the raw entry read at that same block. The chain
  // may hold only expired entries; the expected `usable` covers that case too. If no
  // entry exists on the network, the test is skipped and the log names the network.
  it("reads an existing Account authorization against its raw entry", async (ctx) => {
    const finalized = await client.getFinalizedBlock();
    const at = finalized.hash;

    const blockNow = Number(await api.query.System.Number.getValue({ at }));
    expect(blockNow).toBe(finalized.number);

    // Pages through the map's keys at `at` until one is Account-scoped. The key is
    // prefix ++ hash ++ scope variant (1 byte, Account = 0x00) ++ AccountId32, so the
    // last 33 bytes hold the variant and the account.
    const PAGE = 50;
    let key: string | undefined;
    let startKey: string | null = null;
    for (;;) {
      const page: string[] = await client._request<string[], [string, number, string | null, string]>(
        "state_getKeysPaged",
        [AUTHORIZATIONS_PREFIX, PAGE, startKey, at],
      );
      key = page.find((k: string) => k.slice(-66, -64) === "00");
      if (key || page.length < PAGE) break;
      startKey = page[page.length - 1];
    }
    if (!key) {
      ctx.skip(
        `no Account-scoped Bulletin authorization on ${networkKey()} at finalized #${finalized.number}`,
      );
      return;
    }
    const address = AccountId().dec(Binary.fromHex(`0x${key.slice(-64)}`));
    const found = await api.query.TransactionStorage.Authorizations.getValue(
      { type: "Account", value: address },
      { at },
    );
    if (!found) throw new Error(`Authorizations key ${key} has no value on ${networkKey()}`);
    const { expiration, extent } = found;

    // Raw values from the entry, mirroring the SDK's formulas.
    const rawTransactions = extent.transactions_allowance - extent.transactions;
    const rawBytes = (extent.bytes_allowance as bigint) - (extent.bytes as bigint);
    const rawRemainingBlocks = Math.max(0, expiration - blockNow);
    const rawUsable = blockNow < expiration && rawTransactions > 0 && rawBytes > 0n;

    const status = await getBulletinAllowanceStatus(pinnedTo(api, at), address);
    if (!status.ok) throw status.error;
    const { value } = status;

    expect(value.authorized).toBe(true);
    expect(Number.isInteger(value.remainingTransactions)).toBe(true);
    expect(rawTransactions).toBeGreaterThanOrEqual(0);
    expect(value.remainingTransactions).toBe(rawTransactions);
    expect(value.remainingBytes).toBe(rawBytes);
    expect(rawBytes).toBeGreaterThanOrEqual(0n);
    expect(value.expiration).toBe(expiration);
    expect(value.remainingBlocks).toBe(rawRemainingBlocks);
    expect(value.usable).toBe(rawUsable);
  }, 120_000);
});
