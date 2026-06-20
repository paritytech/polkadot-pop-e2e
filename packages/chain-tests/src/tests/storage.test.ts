import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { AccountId } from "polkadot-api";
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { create as createMultihashDigest } from "multiformats/hashes/digest";
import {
  createBulletinClient,
  createPeopleClient,
  type BulletinApi,
} from "../lib/client.js";
import { type TestAccount } from "../lib/signer.js";
import { submitAndWatchBestBlock } from "../lib/tx.js";
import type { AttestedCredentials } from "../lib/credentials.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { claimLongTermStorage } from "../lib/lts-claim.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

const accountId = AccountId();
const CODEC_RAW = 0x55;
const HASH_SHA2_256 = 0x12;

/**
 * Poll `TransactionStorage.Authorizations[{ Account: addr }]` until an
 * unexpired entry shows up, or `timeoutMs` elapses. The LTS claim above
 * dispatches an XCM `TransactionStorage.AuthorizeAccount` to Bulletin —
 * landing usually takes 30s–2min depending on relay/queues.
 */
async function waitForBulletinAuthorization(
  api: BulletinApi,
  address: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<{ transactions: number; bytes: bigint }> {
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  const pollMs = opts?.pollMs ?? 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const auth = await api.query.TransactionStorage.Authorizations.getValue({
      type: "Account",
      value: address,
    });
    if (auth?.extent) {
      console.log(
        `[storage] Bulletin auth ready after ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
          `${auth.extent.transactions_allowance} txns, ${auth.extent.bytes_allowance} bytes`,
      );
      return {
        transactions: auth.extent.transactions_allowance,
        bytes: auth.extent.bytes_allowance,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Bulletin authorization for ${address} did not appear within ${timeoutMs / 1000}s — ` +
      `did the LTS claim on People chain dispatch via XCM?`,
  );
}

function createAccountFromCredentials(creds: AttestedCredentials): TestAccount {
  const keyPair = deriveKeyPair(creds.entropy);
  const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  return { signer, address: creds.address };
}

function createRandomAccount(): TestAccount {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const keyPair = deriveKeyPair(entropy);
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
  let api: BulletinApi;
  let peopleClient: PolkadotClient | undefined;
  let testAccount: TestAccount;
  let uploadedCid: string;
  let uploadedPayload: Uint8Array;

  beforeAll(async () => {
    assertChainHealthy("bulletin");
    // Storage authorisation flows from People (lite-people allowance)
    // through XCM to Bulletin, so a People outage also breaks Storage.
    assertChainHealthy("people");

    network = getNetworkConfig();
    console.log(`[storage] Network: ${network.name}`);
    console.log(`[storage] Bulletin: ${network.bulletin.ws}`);

    const conn = createBulletinClient(network.bulletin.ws);
    client = conn.client;
    api = conn.api;

    if (!network.features.resources) {
      throw new Error(
        `[storage] ${network.name} doesn't expose Resources/LTS — that's the only ` +
          `authorisation path we support. Set features.resources=true once the ` +
          `runtime supports XCM-driven authorise_account from People.`,
      );
    }
    if (!needsAttestation()) {
      // No IB deployed for this network — leave testAccount unset. The
      // attestation-dependent it()s below all `skipIf(!needsAttestation)`
      // so they never reach for it; only the chain-liveness check runs.
      console.log(`[storage] No Identity Backend configured — skipping attested-account setup`);
      return;
    }
    const creds = await ensureAttested();
    testAccount = createAccountFromCredentials(creds);
    console.log(`[storage] Test account (attested): ${testAccount.address} (${creds.username})`);

    // Idempotent LTS allowance claim on People chain → XCM to Bulletin →
    // testAccount becomes authorised. If Bulletin already has an unexpired
    // entry (e.g. local re-run with REUSE_CREDS=1), skip the claim — the
    // chain rejects same-period re-claims with `Custom(231)`.
    const existing = await api.query.TransactionStorage.Authorizations.getValue({
      type: "Account",
      value: testAccount.address,
    });
    if (existing?.extent) {
      console.log(
        `[storage] Bulletin auth already in place — ${existing.extent.transactions_allowance} txns, ${existing.extent.bytes_allowance} bytes. Skipping LTS claim.`,
      );
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
      // XCM to Bulletin lands shortly after — wait for it before any upload.
      await waitForBulletinAuthorization(api, testAccount.address);
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
          data: uploadedPayload,
        }),
        testAccount.signer,
      );
      const elapsed = Date.now() - start;

      console.log(`[storage] store ok=${result.ok} block=#${result.block?.number} (${elapsed}ms)`);
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  it.skipIf(!needsAttestation())(
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

  // The earlier upload test (`authorized account uploads data and gets
  // CID`) implicitly verifies the authorization was consumed — it would
  // fail if the runtime didn't credit our allowance. Querying the consumed
  // counters here would race the upload's finalization (state queries hit
  // the finalized block; the upload is in best). Not worth the wait.

  it.skipIf(!needsAttestation())(
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
            data: new TextEncoder().encode("should-fail"),
          }),
          fresh.signer,
        );

        expect.unreachable("Unauthorized account should be rejected");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[storage] Unauthorized correctly rejected: ${message.slice(0, 80)}`);
        expect(error).toBeDefined();
      }
    },
    60_000,
  );
});
