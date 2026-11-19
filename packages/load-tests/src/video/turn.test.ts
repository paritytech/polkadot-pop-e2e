import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { freshnessMessage, hex, TURN_ISSUE_PATH, type TurnProofBody } from "@jollity/protocol";
import { ringCollectionId, type PersonhoodProver } from "@parity/product-sdk-individuality";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../time.js";
import { VideoStats } from "./stats.js";
import { fetchTurnPass, TurnPasses, type TurnProofSetup } from "./turn.js";

const CREDENTIALS = { servers: ["turn:turn.example:3478?transport=udp", "turns:turn.example:5349?transport=tcp"], username: "1700000000:alias", password: "secret", ttl: 1800 };

/** An issuer that answers each request with the next of `answers`, the last one repeated. */
async function startIssuer(answers: Array<{ status: number; body: unknown }>): Promise<{ base: string; bodies: TurnProofBody[]; server: Server }> {
  const bodies: TurnProofBody[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`/dub${TURN_ISSUE_PATH}`);
      bodies.push(JSON.parse(text) as TurnProofBody);
      const answer = answers[Math.min(bodies.length, answers.length) - 1];
      response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dub`, bodies, server };
}

/** A lite person's prover that records the messages it proves. */
function liteProver(messages: Uint8Array[]): PersonhoodProver {
  return {
    holds: async (ring) => ring.key === "lite",
    prove: async (_ring, context, message) => {
      messages.push(message);
      return { proof: new Uint8Array([1, 2, 3]), contextualAlias: { context: new Uint8Array(32), alias: new Uint8Array(32) }, ringIndex: 4, ringRevision: 9 };
    },
  } as PersonhoodProver;
}

const GENESIS = `0x${"ab".repeat(32)}` as const;
const setup: TurnProofSetup = { productId: "dim2.testnet", genesis: GENESIS, collectionId: ringCollectionId, hash: blake2b256 };

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((server) => server.close());
  servers = [];
});

// A bot fetches TURN credentials the way the app does, so the issuer sees the same requests, at
// the same times and with the same retries, as from phones; the counts are what the summary shows.
describe("fetchTurnPass", () => {
  it("posts a lite-ring proof of the current second and turns the answer into ICE servers", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const messages: Uint8Array[] = [];
    const stats = new VideoStats();
    const pass = await fetchTurnPass(liteProver(messages), setup, { base: issuer.base, fetch }, stats);

    expect(pass?.turn).toEqual(CREDENTIALS.servers.map((urls) => ({ urls, username: CREDENTIALS.username, credential: CREDENTIALS.password })));
    const [body] = issuer.bodies;
    expect(body).toMatchObject({ productId: "dim2.testnet", collection: hex(ringCollectionId("people-lite")), proof: "0x010203", ringIndex: 4, ringRevision: 9 });
    expect(Math.abs(body.timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(messages).toEqual([freshnessMessage(body.timestamp, blake2b256)]);
    expect(stats.turnFetches).toEqual({ ok: 1 });
    expect(stats.turnIssuerMs.total).toBe(1);
  });

  it("tries an overloaded issuer three times with the same proof", { timeout: 10_000 }, async () => {
    const issuer = await startIssuer([
      { status: 503, body: { error: "no ring roots" } },
      { status: 500, body: { error: "boom" } },
      { status: 200, body: CREDENTIALS },
    ]);
    servers.push(issuer.server);
    const messages: Uint8Array[] = [];
    const stats = new VideoStats();
    const pass = await fetchTurnPass(liteProver(messages), setup, { base: issuer.base, fetch }, stats);

    expect(pass).toBeDefined();
    expect(messages).toHaveLength(1);
    expect(stats.turnFetches).toEqual({ "no-ring-roots 503": 1, "server-error 500": 1, ok: 1 });
  });

  it("proves again for a refused timestamp, and stops at a rate limit", { timeout: 10_000 }, async () => {
    const issuer = await startIssuer([
      { status: 400, body: { error: "timestamp outside window" } },
      { status: 429, body: { error: "too many" } },
    ]);
    servers.push(issuer.server);
    const messages: Uint8Array[] = [];
    const stats = new VideoStats();
    const pass = await fetchTurnPass(liteProver(messages), setup, { base: issuer.base, fetch }, stats);

    expect(pass).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(stats.turnFetches).toEqual({ "timestamp-window 400": 1, "redemption-limit 429": 1 });
  });

  it("counts a bot without a lite key as a proof failure, without asking the issuer", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const stats = new VideoStats();
    const prover = { holds: async () => false, prove: async () => Promise.reject(new Error("unreachable")) } as unknown as PersonhoodProver;
    expect(await fetchTurnPass(prover, setup, { base: issuer.base, fetch }, stats)).toBeUndefined();
    expect(issuer.bodies).toHaveLength(0);
    expect(stats.turnFetches).toEqual({ "proof no-ring-key": 1 });
  });
});

describe("TurnPasses", () => {
  it("fetches when the game is known and again before it, and keeps a pass a failed refresh would drop", async () => {
    const issuer = await startIssuer([
      { status: 200, body: CREDENTIALS },
      { status: 200, body: CREDENTIALS },
      { status: 403, body: { error: "proof rejected" } },
    ]);
    servers.push(issuer.server);
    const provers = new Map([0, 1].map((index) => [index, liteProver([])]));
    const passes = new TurnPasses(provers, setup, { base: issuer.base, fetch });
    // The 10-minute refresh is past; the 3-minute one comes 300 ms from now.
    await passes.warm(Date.now() + 3 * 60_000 + 300);
    expect(issuer.bodies).toHaveLength(2);
    await sleep(800);
    passes.stop();

    expect(issuer.bodies).toHaveLength(4);
    expect(passes.serversOf(0)).toHaveLength(2);
    expect(passes.serversOf(1)).toHaveLength(2);
    expect(passes.serversOf(2)).toEqual([]);
    expect(passes.takeStats().turnFetches).toEqual({ ok: 2, "proof-rejected 403": 2 });
    expect(passes.takeStats().turnFetches).toEqual({});
  });
});
