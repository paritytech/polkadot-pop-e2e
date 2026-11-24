import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { freshnessMessage, hex, TURN_ISSUE_PATH, type TurnProofBody } from "@jollity/protocol";
import { ringCollectionId, type PersonhoodProver } from "@parity/product-sdk-individuality";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../time.js";
import { VideoStats } from "./stats.js";
import { createProofQueue, fetchTurnPass, proveTurnNow, TurnPasses, turnBotOffsets, type ProveTurn, type TurnProofSetup } from "./turn.js";

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
const proveWith = (prover: PersonhoodProver): ProveTurn => () => proveTurnNow(prover, setup);

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
    const pass = await fetchTurnPass(proveWith(liteProver(messages)), { base: issuer.base, fetch }, stats);

    expect(pass?.turn).toEqual(CREDENTIALS.servers.map((urls) => ({ urls, username: CREDENTIALS.username, credential: CREDENTIALS.password })));
    const [body] = issuer.bodies;
    expect(body).toMatchObject({ productId: "dim2.testnet", collection: hex(ringCollectionId("people-lite")), proof: "0x010203", ringIndex: 4, ringRevision: 9 });
    expect(Math.abs(body.timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(messages).toEqual([freshnessMessage(body.timestamp, blake2b256)]);
    expect(stats.turnFetches).toEqual({ ok: 1 });
    expect(stats.turnIssuerMs.total).toBe(1);
  });

  // The issuer takes a proof stamped within 60 s, and the app posts none older than 30 s, so a
  // proof that waited (for other bots' proofs, or a retry) is built again before it goes out.
  it("proves again before posting a proof older than 30 s", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const messages: Uint8Array[] = [];
    const stats = new VideoStats();
    const stale = { body: { productId: "dim2.testnet", collection: "0x00", proof: "0x00", ringIndex: 0, ringRevision: 0, timestamp: 1 }, at: Date.now() - 31_000 };
    expect(await fetchTurnPass(proveWith(liteProver(messages)), { base: issuer.base, fetch }, stats, stale)).toBeDefined();

    expect(messages).toHaveLength(1);
    expect(issuer.bodies).toHaveLength(1);
    expect(Math.abs(issuer.bodies[0].timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(stats.turnProofMs.total).toBe(1);
  });

  it("posts to an overloaded issuer three times with the same proof", { timeout: 10_000 }, async () => {
    const issuer = await startIssuer([
      { status: 503, body: { error: "no ring roots" } },
      { status: 500, body: { error: "boom" } },
      { status: 200, body: CREDENTIALS },
    ]);
    servers.push(issuer.server);
    const messages: Uint8Array[] = [];
    const stats = new VideoStats();
    const pass = await fetchTurnPass(proveWith(liteProver(messages)), { base: issuer.base, fetch }, stats);

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
    const pass = await fetchTurnPass(proveWith(liteProver(messages)), { base: issuer.base, fetch }, stats);

    expect(pass).toBeUndefined();
    expect(messages).toHaveLength(2);
    expect(stats.turnFetches).toEqual({ "timestamp-window 400": 1, "redemption-limit 429": 1 });
  });

  it("counts a bot without a lite key as a proof failure, without asking the issuer", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const stats = new VideoStats();
    const prover = { holds: async () => false, prove: async () => Promise.reject(new Error("unreachable")) } as unknown as PersonhoodProver;
    expect(await fetchTurnPass(proveWith(prover), { base: issuer.base, fetch }, stats)).toBeUndefined();
    expect(issuer.bodies).toHaveLength(0);
    expect(stats.turnFetches).toEqual({ "proof no-ring-key": 1 });
  });
});

describe("createProofQueue", () => {
  // A worker thread takes many TURN jobs at once; stamping them all before the first proof is built
  // would post the last one many proofs' time after its stamp, past the 30 s the app allows.
  it("stamps each proof when the one before it is done", async () => {
    const slowProver = {
      holds: async (ring) => ring.key === "lite",
      prove: async () => {
        await sleep(200);
        return { proof: new Uint8Array([1]), contextualAlias: { context: new Uint8Array(32), alias: new Uint8Array(32) }, ringIndex: 0, ringRevision: 0 };
      },
    } as PersonhoodProver;
    const proveInTurn = createProofQueue();
    const outcomes = await Promise.all([0, 1, 2].map(() => proveInTurn(proveWith(slowProver))));
    const proofs = outcomes.map((outcome) => ("proof" in outcome ? outcome : undefined));

    for (const [position, outcome] of proofs.entries()) {
      expect(outcome!.ms).toBeLessThan(400);
      if (position > 0) expect(outcome!.proof.at).toBeGreaterThanOrEqual(proofs[position - 1]!.proof.at + 190);
    }
  });
});

describe("TurnPasses", () => {
  // The app refreshes a pass before the game only when it has under 10 minutes left, so a run
  // must not send the issuer a burst of proofs at each refresh time that phones don't send.
  it("refreshes a pass with under 10 minutes left before the game, and uses the old pass when the refresh fails", async () => {
    const shortPass = { ...CREDENTIALS, ttl: 300 };
    const issuer = await startIssuer([
      { status: 200, body: shortPass },
      { status: 200, body: shortPass },
      { status: 403, body: { error: "proof rejected" } },
    ]);
    servers.push(issuer.server);
    const provers = new Map([0, 1].map((index) => [index, proveWith(liteProver([]))]));
    const passes = new TurnPasses(provers, { base: issuer.base, fetch });
    // The 10-minute refresh is past; the 3-minute one comes 300 ms from now.
    await passes.warm(Date.now() + 3 * 60_000 + 300);
    expect(issuer.bodies).toHaveLength(2);
    await sleep(800);
    passes.stop();

    expect(issuer.bodies).toHaveLength(4);
    expect(passes.serversOf(0)).toHaveLength(2);
    expect(passes.serversOf(1)).toHaveLength(2);
    expect(passes.serversOf(2)).toBeNull();
    expect(passes.takeStats().turnFetches).toEqual({ ok: 2, "proof-rejected 403": 2 });
    expect(passes.takeStats().turnFetches).toEqual({});
  });

  it("leaves a pass with 10 minutes or more alone at a refresh", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const passes = new TurnPasses(new Map([[0, proveWith(liteProver([]))]]), { base: issuer.base, fetch });
    await passes.warm(Date.now() + 3 * 60_000 + 300);
    await sleep(800);
    passes.stop();

    expect(issuer.bodies).toHaveLength(1);
    expect(passes.takeStats().turnFetches).toEqual({ ok: 1 });
  });
});

// A run mixes bots that take TURN relay ports, as phones do, with bots on STUN only, so a live
// game's testers keep the TURN server's ports and the summary compares both groups.
describe("TURN bots", () => {
  it("are the run's first --turn-bots lite bots by offset, on any shard", () => {
    const shard = [1, 3, 5, 7];
    expect(turnBotOffsets(shard, 0)).toEqual([]);
    expect(turnBotOffsets(shard, 5)).toEqual([1, 3]);
    expect(turnBotOffsets(shard, 8)).toEqual(shard);
    expect(turnBotOffsets(shard, Infinity)).toEqual(shard);
  });

  it("leave the STUN-only bots without a proof or an issuer request", async () => {
    const issuer = await startIssuer([{ status: 200, body: CREDENTIALS }]);
    servers.push(issuer.server);
    const proved: number[] = [];
    const provers = new Map(
      turnBotOffsets([0, 1, 2], 1).map((offset): [number, ProveTurn] => [
        offset,
        () => {
          proved.push(offset);
          return proveWith(liteProver([]))();
        },
      ]),
    );
    const passes = new TurnPasses(provers, { base: issuer.base, fetch });
    await passes.warm(Date.now());
    passes.stop();

    expect(proved).toEqual([0]);
    expect(issuer.bodies).toHaveLength(1);
    expect(passes.serversOf(0)).toHaveLength(2);
    expect(passes.serversOf(1)).toBeNull();
    expect(passes.serversOf(2)).toBeNull();
  });
});
