import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import {
  HopClient,
  HopNotFoundError,
  type CustomEnvironment,
  type HopTicket,
} from "hop-sdk";
import { createBulletinClient, createPeopleClient } from "../lib/client.js";
import { ensureAttested } from "../lib/attested-fixture.js";
import { deriveKeyPair } from "../lib/attestation.js";
import { claimLongTermStorage } from "../lib/lts-claim.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

/**
 * HOP requires raw byte signing — the SDK calls `signBytes(payload)` and
 * expects a bare sr25519 signature. `getPolkadotSigner` would wrap the
 * payload in `<Bytes>…</Bytes>`, which the runtime rejects as `BadProof`.
 * Mirrors `examples/hop_round_trip.js:rawSigner` in polkadot-bulletin-chain.
 */
function rawSigner(keyPair: {
  publicKey: Uint8Array;
  sign: (data: Uint8Array) => Uint8Array;
}) {
  return {
    publicKey: keyPair.publicKey,
    signTx: () => Promise.reject(new Error("signTx is not used by HOP")),
    signBytes: async (data: Uint8Array) => keyPair.sign(data),
  };
}

/**
 * Claim with retry on `HopNotFoundError` — after `hop_submit` returns OK
 * the entry isn't always immediately visible to the next claim call.
 * Mirrors `pollAndClaim` in polkadot-bulletin-chain's `hop_round_trip.js`.
 */
async function pollClaim(
  client: HopClient,
  ticket: HopTicket,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<Uint8Array> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await client.claim(ticket);
    } catch (err) {
      if (!(err instanceof HopNotFoundError)) throw err;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error(
    `hop_claim returned NOT_FOUND repeatedly for ${timeoutMs / 1000}s — ` +
      `submit landed but entry never became claimable`,
  );
}

/** Poll `HopRuntimeApi.can_account_promote` until the signer is HOP-eligible. */
async function waitForHopAuthorization(
  hop: HopClient,
  address: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  const pollMs = opts?.pollMs ?? 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hop.canAccountPromote(address, 100)) {
      console.log(
        `[hop] HOP-eligible after ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `can_account_promote(${address}) stayed false for ${timeoutMs / 1000}s`,
  );
}

describe("HOP: Submit and Claim on Bulletin", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let peopleClient: PolkadotClient | undefined;
  let senderHop: HopClient;
  let address: string;

  beforeAll(async () => {
    network = getNetworkConfig();
    // HOP RPCs must hit a collator started with `--enable-hop`. When the
    // network pins a dedicated `bulletin.hopWs`, use it; otherwise assume
    // the public Bulletin RPC is itself a hop collator.
    const hopWs = network.bulletin.hopWs ?? network.bulletin.ws;
    console.log(`[hop] Network: ${network.name}`);
    console.log(`[hop] Bulletin: ${network.bulletin.ws}`);
    console.log(`[hop] HOP endpoint: ${hopWs}`);

    if (!network.features.hop) {
      throw new Error(
        `[hop] ${network.name} does not expose the HOP RPCs. Set features.hop=true ` +
          `once the collator runs with --enable-hop and the runtime includes ` +
          `pallet-bulletin-hop-promotion.`,
      );
    }
    if (!network.features.resources) {
      throw new Error(
        `[hop] ${network.name} doesn't expose Resources/LTS — HOP submit requires ` +
          `an active TransactionStorage authorization on the signer, which is ` +
          `the LTS-claim path.`,
      );
    }

    ({ client } = createBulletinClient(network.bulletin.ws));

    const creds = await ensureAttested();
    address = creds.address;
    const keyPair = deriveKeyPair(creds.entropy);

    // `CustomEnvironment` is a `ws://${string}` | `wss://${string}` template
    // literal; our config types the endpoint as plain `string` so cast at
    // the boundary — hop-sdk validates the URL itself anyway.
    senderHop = HopClient.connectWithAccount(
      hopWs as CustomEnvironment,
      rawSigner(keyPair),
      "sr25519",
    );
    console.log(`[hop] Test account (attested): ${address} (${creds.username})`);

    // Idempotent: skip the LTS claim if the signer is already HOP-eligible
    // (re-claims in the same period fail with `Custom(231)`).
    if (await senderHop.canAccountPromote(address, 100)) {
      console.log(`[hop] Already HOP-eligible — skipping LTS claim.`);
    } else {
      const peopleConn = createPeopleClient(network.people.ws);
      peopleClient = peopleConn.client;
      const claim = await claimLongTermStorage(peopleConn.api, peopleClient, creds);
      if (!claim.ok) {
        throw new Error(
          `[hop] LTS allowance claim failed (period=${claim.period}). ` +
            `Cannot test the HOP submit path without an authorized signer.`,
        );
      }
      await waitForHopAuthorization(senderHop, address);
    }
  }, 300_000);

  afterAll(() => {
    senderHop?.destroy();
    client?.destroy();
    peopleClient?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[hop] Finalized block #${block.number} (${block.hash})`);
    expect(block.number).toBeGreaterThan(0);
  });

  it("authorized account is promote-eligible (HopRuntimeApi.can_account_promote)", async () => {
    // The runtime API is account-level, so any positive `data_len` should
    // return the same answer. Cross-checking two sizes guards against a
    // future where the runtime quietly starts bounding by size — the test
    // would then fail with a clear "started rejecting at N bytes" signal.
    const smallOk = await senderHop.canAccountPromote(address, 100);
    const largeOk = await senderHop.canAccountPromote(address, 1024 * 1024);
    expect(smallOk).toBe(true);
    expect(largeOk).toBe(true);
  });

  it(
    "submit → claim → ack round-trip",
    async () => {
      const payloadStr = `triangle-e2e-hop-${network.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const payload = new TextEncoder().encode(payloadStr);
      console.log(`[hop] Submitting the payload: "${payloadStr}" (${payload.length} bytes)`);

      const submittedAt = Date.now();
      const tickets = await senderHop.send(payload, 1);
      const ticketHex = Buffer.from(tickets[0]!.encode()).toString("hex").slice(0, 16);
      console.log(`[hop] hop_submit ok after ${Date.now() - submittedAt}ms — ticket ${ticketHex}…`);
      expect(tickets.length).toBe(1);

      console.log(`[hop] Claiming ticket ${ticketHex}…`);
      const received = await pollClaim(senderHop, tickets[0]!);
      console.log(`[hop] Claimed ${received.length} bytes`);
      expect(new TextDecoder().decode(received)).toBe(payloadStr);

      console.log(`[hop] Acking ticket ${ticketHex}…`);
      await senderHop.ack(tickets[0]!);
      console.log(`[hop] Acked`);

      // Single-recipient ack deletes the entry, so a second claim or ack
      // throws `HopNotFoundError`.
      await expect(senderHop.claim(tickets[0]!)).rejects.toBeInstanceOf(HopNotFoundError);
      await expect(senderHop.ack(tickets[0]!)).rejects.toBeInstanceOf(HopNotFoundError);

      console.log(
        `[hop] full round-trip completed in ${Date.now() - submittedAt}ms`,
      );
    },
    90_000,
  );
});
