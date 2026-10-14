import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import { AccountId } from "@polkadot-api/substrate-bindings";
import {
  createSr25519Secret,
  deriveSr25519PublicKey,
  NoAllowanceError,
} from "@novasamatech/statement-store";
import { StatementStoreClient, StatementSubmitError } from "@parity/product-sdk-statement-store";
import { createPeopleClient, type PeopleApi } from "../lib/client.js";
import type { AttestedCredentials } from "../lib/credentials.js";
import { claimStatementAllowance } from "../lib/statement-allowance.js";
import { ensureAttested, needsAttestation } from "../lib/attested-fixture.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { createNodeStatementTransport } from "../lib/statement-transport.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

describe("Statement: People Chain + Identity Backend", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let peopleApi: PeopleApi;
  let creds: AttestedCredentials;
  // Hosts sign statements with a per-product allowance key, not the person's key.
  let statementSecret: Uint8Array;
  const clients: StatementStoreClient[] = [];

  beforeAll(async () => {
    assertChainHealthy("people");

    network = getNetworkConfig();
    console.log(`[statement] Network: ${network.name}`);
    console.log(`[statement] People: ${network.people.ws}`);
    console.log(`[statement] Identity Backend: ${network.identityBackend ?? "none"}`);

    const conn = createPeopleClient(network.people.ws);
    client = conn.client;
    peopleApi = conn.api;

    if (network.identityBackend) {
      creds = await ensureAttested();
      statementSecret = createSr25519Secret(creds.entropy, "//allowance//statement-store//pop-e2e.dot");
      console.log(`[statement] Attested account: ${creds.address} (${creds.username})`);
    }
  });

  afterAll(() => {
    clients.forEach((c) => c.destroy());
    client?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[statement] Finalized block #${block.number} (${block.hash})`);

    expect(block.number).toBeGreaterThan(0);
    expect(block.hash).toBeTruthy();
  });

  it.skipIf(!needsAttestation())("identity backend is healthy", async () => {
    const start = Date.now();
    const res = await fetch(`${network.identityBackend}/healthcheck`, {
      signal: AbortSignal.timeout(10_000),
    });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(true);

    // The generations answer different shapes: IBv1 `{message: "OK", uptime}`,
    // IBv2 (identity-backend-rust) `{status: "ok", service}`.
    if (network.identityBackendAuth === "challenge") {
      const body = (await res.json()) as { status: string; service: string };
      console.log(`[statement] Backend health: ${body.status} (${body.service}, ${elapsed}ms)`);
      expect(body.status).toBe("ok");
    } else {
      const body = (await res.json()) as { message: string; uptime: number };
      console.log(
        `[statement] Backend health: ${body.message}, uptime=${Math.floor(body.uptime)}s (${elapsed}ms)`,
      );
      expect(body.message).toBe("OK");
    }
  });

  /** A product-sdk client publishing as `secret`, with the transport a host would provide. */
  async function connectClient(secret: Uint8Array): Promise<StatementStoreClient> {
    const { transport, signer } = createNodeStatementTransport(network.people.ws, secret);
    const client = new StatementStoreClient({ appName: `pop-e2e-${Date.now()}`, transport });
    await client.connect({ mode: "local", signer });
    clients.push(client);
    return client;
  }

  it.skipIf(!needsAttestation())(
    "claims a statement allowance for the product key",
    async () => {
      const target = AccountId().dec(deriveSr25519PublicKey(statementSecret));
      const allowance = await claimStatementAllowance(peopleApi, client, creds, target);
      console.log(
        `[statement] Allowance for ${target}: period=${allowance.period} seq=${allowance.seq} ` +
          (allowance.claimed ? "claimed" : "already held"),
      );
    },
    240_000,
  );

  it.skipIf(!needsAttestation())("Statement Store write succeeds with the product key", async () => {
    const statements = await connectClient(statementSecret);
    const result = await statements.publish({ probe: Date.now() });
    if (!result.ok) throw result.error;
  });

  it.skipIf(!needsAttestation())(
    "Statement Store write + read roundtrip",
    async () => {
      const statements = await connectClient(statementSecret);
      const marker = `pop-e2e-roundtrip-${Date.now()}`;
      const received = new Promise<void>((resolve) => {
        statements.subscribe<{ marker: string }>((s) => {
          if (s.data?.marker === marker) resolve();
        });
      });

      const result = await statements.publish({ marker });
      if (!result.ok) throw result.error;
      await received;
      console.log(`[statement] Roundtrip: data verified`);
    },
    60_000,
  );

  it.skipIf(!needsAttestation())(
    "non-attested account is rejected by Statement Store",
    async () => {
      const entropy = new Uint8Array(32);
      crypto.getRandomValues(entropy);
      const statements = await connectClient(createSr25519Secret(entropy));

      const result = await statements.publish({ shouldBe: "rejected" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(StatementSubmitError);
        expect((result.error as StatementSubmitError).detail).toBeInstanceOf(NoAllowanceError);
      }
      console.log(`[statement] Non-PoP account correctly rejected with NoAllowanceError`);
    },
  );
});
