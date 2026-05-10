import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { fromHex } from "@polkadot-api/utils";
import {
  createLazyClient,
  createPapiStatementStoreAdapter,
  createSr25519Prover,
  createSr25519Secret,
  NoAllowanceError,
  type StatementStoreAdapter,
  type StatementProver,
} from "@novasamatech/statement-store";
import { stringToTopic, createExpiryFromDuration } from "@novasamatech/sdk-statement";
import { createPeopleClient } from "../lib/client.js";
import { loadCredentials } from "../lib/credentials.js";
import { getNetworkConfig, type NetworkConfig } from "../config/networks.js";

describe("Statement: People Chain + Identity Backend", () => {
  let network: NetworkConfig;
  let client: PolkadotClient;
  let adapter: StatementStoreAdapter;
  let prover: StatementProver;
  let lazyClient: ReturnType<typeof createLazyClient>;
  const hasBackend = () => getNetworkConfig().identityBackend !== null;

  beforeAll(async () => {
    network = getNetworkConfig();
    console.log(`[statement] Network: ${network.name}`);
    console.log(`[statement] People: ${network.people.ws}`);
    console.log(`[statement] Identity Backend: ${network.identityBackend ?? "none"}`);

    const conn = createPeopleClient(network.people.ws);
    client = conn.client;

    if (network.identityBackend) {
      lazyClient = createLazyClient(getWsProvider(network.people.ws));
      adapter = createPapiStatementStoreAdapter(lazyClient);

      const creds = loadCredentials();
      if (creds.attested) {
        prover = createSr25519Prover(creds.statementStoreSecret);
        console.log(`[statement] Attested account: ${creds.address} (${creds.username})`);
      }
    }
  });

  afterAll(() => {
    lazyClient?.disconnect();
    client?.destroy();
  });

  it("chain is producing finalized blocks", async () => {
    const block = await client.getFinalizedBlock();
    console.log(`[statement] Finalized block #${block.number} (${block.hash})`);

    expect(block.number).toBeGreaterThan(0);
    expect(block.hash).toBeTruthy();
  });

  it.skipIf(!hasBackend())("identity backend is healthy", async () => {
    const start = Date.now();
    const res = await fetch(`${network.identityBackend}/healthcheck`, {
      signal: AbortSignal.timeout(10_000),
    });
    const elapsed = Date.now() - start;
    const body = (await res.json()) as { message: string; uptime: number };

    console.log(
      `[statement] Backend health: ${body.message}, uptime=${Math.floor(body.uptime)}s (${elapsed}ms)`,
    );
    expect(res.ok).toBe(true);
    expect(body.message).toBe("OK");
  });

  it.skipIf(!hasBackend())(
    "Statement Store write succeeds (after attestation)",
    async () => {
      // Wait for daemon to process attestation from global setup
      console.log(`[statement] Waiting for attestation daemon to process...`);
      const maxWait = 90_000;
      const pollInterval = 5_000;
      const startWait = Date.now();
      let writeOk = false;

      while (Date.now() - startWait < maxWait) {
        const topicHex = stringToTopic(`triangle-e2e-probe-${Date.now()}`);
        const data = new TextEncoder().encode("probe");
        const expiry = createExpiryFromDuration(300);

        const signed = await prover.generateMessageProof({
          topics: [topicHex],
          data,
          expiry,
        });
        if (signed.isErr()) {
          throw new Error(`Proof generation failed: ${signed.error.message}`);
        }

        const result = await adapter.submitStatement(signed._unsafeUnwrap());
        if (result.isOk()) {
          writeOk = true;
          const elapsed = Date.now() - startWait;
          console.log(`[statement] Statement write succeeded after ${elapsed}ms wait`);
          break;
        }

        const elapsed = Date.now() - startWait;
        console.log(`[statement] Waiting... (${elapsed}ms) - ${result.error.message}`);
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      expect(writeOk).toBe(true);
    },
    120_000,
  );

  it.skipIf(!hasBackend())(
    "Statement Store write + read roundtrip",
    async () => {
      const uniqueId = `triangle-e2e-roundtrip-${Date.now()}`;
      const topicHex = stringToTopic(uniqueId);
      const topicBytes = fromHex(topicHex);
      const payload = new TextEncoder().encode(uniqueId);
      const expiry = createExpiryFromDuration(300);

      // Write
      const signed = await prover.generateMessageProof({
        topics: [topicHex],
        data: payload,
        expiry,
      });
      expect(signed.isOk()).toBe(true);

      const writeStart = Date.now();
      const writeResult = await adapter.submitStatement(signed._unsafeUnwrap());
      if (writeResult.isErr()) {
        throw new Error(`Statement Store write failed: ${writeResult.error.message}`);
      }
      console.log(`[statement] Roundtrip: wrote (${Date.now() - writeStart}ms)`);

      // Read back
      const readStart = Date.now();
      const readResult = await adapter.queryStatements({ matchAll: [topicBytes] });
      if (readResult.isErr()) {
        throw new Error(`Statement Store read failed: ${readResult.error.message}`);
      }

      const statements = readResult._unsafeUnwrap();
      console.log(`[statement] Roundtrip: read ${statements.length} statement(s) (${Date.now() - readStart}ms)`);
      expect(statements.length).toBeGreaterThan(0);

      const found = statements.find((s) => {
        if (!s.data) return false;
        try {
          const decoded = new TextDecoder().decode(
            s.data instanceof Uint8Array ? s.data : fromHex(s.data as string),
          );
          return decoded === uniqueId;
        } catch {
          return false;
        }
      });
      expect(found).toBeDefined();
      console.log(`[statement] Roundtrip: data verified`);
    },
    60_000,
  );

  it.skipIf(!hasBackend())(
    "non-attested account is rejected by Statement Store",
    async () => {
      const entropy = new Uint8Array(32);
      crypto.getRandomValues(entropy);
      const secret = createSr25519Secret(entropy);
      const nonPopProver = createSr25519Prover(secret);

      const topicHex = stringToTopic(`triangle-e2e-nonpop-${Date.now()}`);
      const data = new TextEncoder().encode("should-be-rejected");
      const expiry = createExpiryFromDuration(300);

      const signed = await nonPopProver.generateMessageProof({
        topics: [topicHex],
        data,
        expiry,
      });
      expect(signed.isOk()).toBe(true);

      const result = await adapter.submitStatement(signed._unsafeUnwrap());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(NoAllowanceError);
      console.log(`[statement] Non-PoP account correctly rejected with NoAllowanceError`);
    },
  );
});
