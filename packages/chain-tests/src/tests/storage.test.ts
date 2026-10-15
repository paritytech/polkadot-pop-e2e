import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { getTxCreator } from "polkadot-api/tx-creator";
import { AsyncBulletinClient, type BulletinTypedApi, type SubmitFn } from "@parity/bulletin-sdk";
import { CloudStorageClient, type CloudStorageApi } from "@parity/product-sdk-cloud-storage";
import { createBulletinClient, createPeopleClient, type BulletinApi } from "../lib/client.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { claimLongTermStorage } from "../lib/lts-claim.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";
import { identityKey, personKey } from "../lib/truapi-identity.js";
/** A product-sdk storage client over our own connection, as a BYOD product would build it. */
function cloudStorage(client: PolkadotClient, api: BulletinApi, signer: CommonSignerTxCreator) {
  const inner = new AsyncBulletinClient(
    api as unknown as BulletinTypedApi,
    signer,
    client.submit as unknown as SubmitFn,
  );
  return CloudStorageClient.from(inner, api as unknown as CloudStorageApi);
}

/**
 * Poll the account's Bulletin authorization until it appears, or `timeoutMs`
 * elapses. The LTS claim dispatches an XCM `TransactionStorage.AuthorizeAccount`
 * to Bulletin, which usually lands within 30s-2min.
 */
async function waitForBulletinAuthorization(
  storage: CloudStorageClient,
  address: string,
  timeoutMs = 240_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await storage.checkAuthorization(address);
    if (!status.ok) throw status.error;
    if (status.value.authorized) {
      console.log(
        `[storage] Bulletin auth ready after ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
          `${status.value.remainingTransactions} txns, ${status.value.remainingBytes} bytes`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `Bulletin authorization for ${address} did not appear within ${timeoutMs / 1000}s — ` +
      `did the LTS claim on People chain dispatch via XCM?`,
  );
}

function randomSigner(): CommonSignerTxCreator {
  const keyPair = identityKey(crypto.getRandomValues(new Uint8Array(16)), "testnet");
  return getTxCreator(keyPair.publicKey, "Sr25519", keyPair.sign);
}

describe("Storage: Bulletin Chain", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let api: BulletinApi;
  let peopleClient: PolkadotClient | undefined;
  let storage: CloudStorageClient;
  let address: string;
  let uploaded: { cid: string; block: number; payload: Uint8Array };

  beforeAll(async () => {
    assertChainHealthy("bulletin");
    // Storage authorisation flows from People (lite-people allowance)
    // through XCM to Bulletin, so a People outage also breaks Storage.
    assertChainHealthy("people");

    network = getNetworkConfig();
    console.log(`[storage] Network: ${network.name}`);
    console.log(`[storage] Bulletin: ${network.bulletin.ws}`);

    ({ client, api } = createBulletinClient(network.bulletin.ws));

    if (!network.features.resources) {
      throw new Error(
        `[storage] ${network.name} doesn't expose Resources/LTS — that's the only ` +
          `authorisation path we support. Set features.resources=true once the ` +
          `runtime supports XCM-driven authorise_account from People.`,
      );
    }
    if (!needsAttestation()) {
      // No IB deployed for this network: only the chain-liveness check runs.
      console.log(`[storage] No Identity Backend configured — skipping attested-account setup`);
      return;
    }
    const creds = await ensureAttested();
    const keyPair = personKey(creds);
    address = creds.address;
    storage = cloudStorage(client, api, getTxCreator(keyPair.publicKey, "Sr25519", keyPair.sign));
    console.log(`[storage] Test account (attested): ${address} (${creds.username})`);

    // Bulletin rejects a second LTS claim in the same period with
    // `Custom(231)`, so skip it when an authorization is already in place.
    const existing = await storage.checkAuthorization(address);
    if (!existing.ok) throw existing.error;
    if (existing.value.authorized) {
      console.log(`[storage] Bulletin auth already in place. Skipping LTS claim.`);
    } else {
      const peopleConn = createPeopleClient(network.people.ws);
      peopleClient = peopleConn.client;
      const claim = await claimLongTermStorage(peopleConn.api, peopleClient, creds);
      if (!claim.ok) {
        throw new Error(
          `[storage] LTS allowance claim failed (period=${claim.period}). ` +
            `Cannot test the XCM-driven authorisation path.`,
        );
      }
      await waitForBulletinAuthorization(storage, address);
    }
  }, 300_000);

  afterAll(() => {
    client?.destroy();
    peopleClient?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[storage] Finalized block #${block.number} (${block.hash})`);

    expect(block.number).toBeGreaterThan(0);
    expect(block.hash).toBeTruthy();
  });

  it.skipIf(!needsAttestation())(
    "authorized account uploads data and gets CID",
    async () => {
      // Nondeterministic payload — different CID every run
      const payload = new TextEncoder().encode(
        `pop-e2e-health-${network.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const start = Date.now();
      const result = await storage.store(payload).send();
      if (!result.cid || result.blockNumber === undefined) {
        throw new Error(`[storage] store returned no CID or block: ${JSON.stringify(result)}`);
      }
      uploaded = { cid: result.cid.toString(), block: result.blockNumber, payload };
      console.log(`[storage] stored ${uploaded.cid} at #${uploaded.block} (${Date.now() - start}ms)`);
    },
    120_000,
  );

  it.skipIf(!needsAttestation())(
    "uploaded CID is recorded on chain",
    async () => {
      // verifyStored reads finalized state; the store receipt is from best block.
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
        const entry = await storage.verifyStored(uploaded.cid, { block: uploaded.block });
        if (!entry.ok) throw entry.error;
        if (entry.value) {
          expect(entry.value.size).toBe(uploaded.payload.length);
          return;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      throw new Error(`[storage] ${uploaded.cid} not found at #${uploaded.block} once finalized`);
    },
    60_000,
  );

  it.skipIf(!needsAttestation())(
    "uploaded CID is retrievable from IPFS gateway",
    async () => {
      const url = `${network.ipfsGateway}/${uploaded.cid}`;
      console.log(`[storage] Fetching: ${url}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      console.log(`[storage] IPFS gateway status=${response.status}`);
      expect(response.ok).toBe(true);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(uploaded.payload);
    },
    60_000,
  );

  it.skipIf(!needsAttestation())(
    "unauthorized account is rejected",
    async () => {
      const fresh = cloudStorage(client, api, randomSigner());
      await expect(fresh.store(new TextEncoder().encode("should-fail")).send()).rejects.toThrow();
    },
    60_000,
  );
});
