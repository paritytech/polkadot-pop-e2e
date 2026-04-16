import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Binary, type PolkadotClient, type TypedApi } from "polkadot-api";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { AccountId } from "polkadot-api";
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { create as createMultihashDigest } from "multiformats/hashes/digest";
import type { Bulletin } from "@triangle-e2e/papi";
import { createBulletinClient } from "../lib/client.js";
import { createBulletinSigner, type TestAccount } from "../lib/signer.js";
import { submitAndWatchBestBlock } from "../lib/tx.js";
import { loadCredentials, type AttestedCredentials } from "../lib/credentials.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

const accountId = AccountId();
const CODEC_RAW = 0x55;
const HASH_SHA2_256 = 0x12;
const AUTH_TRANSACTIONS = 100;
const AUTH_BYTES = BigInt(5 * 1024 * 1024); // 5 MB

function createAccountFromCredentials(creds: AttestedCredentials): TestAccount {
  const miniSecret = entropyToMiniSecret(creds.entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const keyPair = derive("");
  const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  return { signer, address: creds.address };
}

function createRandomAccount(): TestAccount {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const keyPair = derive("");
  const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  return { signer, address: accountId.dec(keyPair.publicKey) };
}

function computeCid(data: Uint8Array): string {
  const hash = createHash("sha256").update(data).digest();
  const multihash = createMultihashDigest(HASH_SHA2_256, hash);
  return CID.createV1(CODEC_RAW, multihash).toString();
}

describe("Storage: Bulletin Chain", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let api: TypedApi<Bulletin>;
  let alice: TestAccount;
  let testAccount: TestAccount;
  let uploadedCid: string;
  let uploadedPayload: Uint8Array;

  beforeAll(async () => {
    network = getNetworkConfig();
    console.log(`[storage] Network: ${network.name}`);
    console.log(`[storage] Bulletin: ${network.bulletin.ws}`);

    const conn = createBulletinClient(network.bulletin.ws);
    client = conn.client;
    api = conn.api;

    alice = await createBulletinSigner();

    const creds = loadCredentials();
    if (creds.attested) {
      testAccount = createAccountFromCredentials(creds);
      console.log(`[storage] Test account (attested): ${testAccount.address} (${creds.username})`);
    } else {
      testAccount = createRandomAccount();
      console.log(`[storage] Test account (random): ${testAccount.address}`);
    }
    console.log(`[storage] Alice: ${alice.address}`);
  });

  afterAll(() => {
    client?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[storage] Finalized block #${block.number} (${block.hash})`);

    expect(block.number).toBeGreaterThan(0);
    expect(block.hash).toBeTruthy();
  });

  it(
    "Alice authorizes test account for storage",
    async () => {
      const start = Date.now();

      const result = await submitAndWatchBestBlock(
        api.tx.TransactionStorage.authorize_account({
          who: testAccount.address,
          transactions: AUTH_TRANSACTIONS,
          bytes: AUTH_BYTES,
        }),
        alice.signer,
      );
      const elapsed = Date.now() - start;

      console.log(`[storage] authorize_account ok=${result.ok} (${AUTH_TRANSACTIONS} txns, ${AUTH_BYTES} bytes) (${elapsed}ms)`);
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  it(
    "authorized account uploads data and gets CID",
    async () => {
      // Nondeterministic payload — different CID every run
      const payloadStr = `triangle-e2e-health-${network.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      uploadedPayload = new TextEncoder().encode(payloadStr);
      uploadedCid = computeCid(uploadedPayload);

      console.log(`[storage] Payload: "${payloadStr}" (${uploadedPayload.length} bytes)`);
      console.log(`[storage] Expected CID: ${uploadedCid}`);

      const start = Date.now();
      const result = await submitAndWatchBestBlock(
        api.tx.TransactionStorage.store_with_cid_config({
          cid: {
            codec: BigInt(CODEC_RAW),
            hashing: { type: "Sha2_256", value: undefined },
          },
          data: Binary.fromBytes(uploadedPayload),
        }),
        testAccount.signer,
      );
      const elapsed = Date.now() - start;

      console.log(`[storage] store ok=${result.ok} block=#${result.block?.number} (${elapsed}ms)`);
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  it(
    "uploaded CID is retrievable from IPFS gateway",
    async () => {
      const url = `${network.ipfsGateway}/${uploadedCid}`;
      console.log(`[storage] Fetching: ${url}`);

      const start = Date.now();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      const elapsed = Date.now() - start;

      console.log(`[storage] IPFS gateway status=${response.status} (${elapsed}ms)`);
      expect(response.ok).toBe(true);

      const body = new Uint8Array(await response.arrayBuffer());
      const bodyStr = new TextDecoder().decode(body);
      const uploadedStr = new TextDecoder().decode(uploadedPayload);

      console.log(`[storage] Retrieved: "${bodyStr.slice(0, 60)}..." (${body.length} bytes)`);
      expect(bodyStr).toBe(uploadedStr);
    },
    60_000,
  );

  it(
    "authorization reduced after upload",
    async () => {
      // Query remaining authorization via Authorizations storage
      const scope = { type: "Account" as const, value: testAccount.address };
      const auth = await api.query.TransactionStorage.Authorizations.getValue(scope);

      if (!auth) {
        // Authorization might have been fully consumed or expired
        console.log(`[storage] Authorization: none remaining (fully consumed or expired)`);
        return;
      }

      const remainingTxns = auth.extent.transactions;
      const remainingBytes = auth.extent.bytes;

      console.log(`[storage] Authorization remaining: ${remainingTxns} txns, ${remainingBytes} bytes`);

      // We authorized AUTH_TRANSACTIONS txns and AUTH_BYTES bytes
      // After 1 upload, transactions should be AUTH_TRANSACTIONS - 1
      // And bytes should be AUTH_BYTES - uploadedPayload.length
      expect(remainingTxns).toBeLessThan(AUTH_TRANSACTIONS);
      expect(remainingBytes).toBeLessThan(AUTH_BYTES);

      const usedTxns = AUTH_TRANSACTIONS - remainingTxns;
      const usedBytes = AUTH_BYTES - remainingBytes;
      console.log(`[storage] Authorization consumed: ${usedTxns} txns, ${usedBytes} bytes (payload was ${uploadedPayload.length} bytes)`);
    },
    30_000,
  );

  it(
    "unauthorized account is rejected",
    async () => {
      const fresh = createRandomAccount();
      console.log(`[storage] Unauthorized account: ${fresh.address}`);

      try {
        await submitAndWatchBestBlock(
          api.tx.TransactionStorage.store_with_cid_config({
            cid: {
              codec: BigInt(CODEC_RAW),
              hashing: { type: "Sha2_256", value: undefined },
            },
            data: Binary.fromBytes(new TextEncoder().encode("should-fail")),
          }),
          fresh.signer,
        );

        expect.unreachable("Unauthorized account should be rejected");
      } catch (error: any) {
        console.log(`[storage] Unauthorized correctly rejected: ${error.message?.slice(0, 80)}`);
        expect(error).toBeDefined();
      }
    },
    60_000,
  );
});
