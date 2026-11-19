import { toHex, type WireStatement } from "@jollity/statement-core";
import { describe, expect, it } from "vitest";
import { SignallingBot } from "./bot.js";
import { derivePlayer, type Player } from "./keys.js";
import type { DeliveredStatement, MeasurableStore } from "./measured-store.js";
import { PROFILES } from "./profile.js";
import { DEFAULT_THRESHOLDS, summarizeStep } from "./report.js";
import type { SignallingShardResult } from "./signalling.js";
import { SignallingStats } from "./stats.js";
import { sleep } from "./time.js";

/**
 * A statement store in memory: one statement per channel, each delivered to the subscribers of its
 * topic, and a subscriber that opens later gets the statement each channel still contains, as a node
 * answers a new subscription.
 */
class MemoryStore {
  readonly submitted: WireStatement[] = [];
  private readonly latestByChannel = new Map<string, DeliveredStatement & { topics: string[] }>();
  private readonly subscribers = new Set<{ topics: Set<string>; onPage(page: { statements: DeliveredStatement[] }): void }>();

  storeOf(player: Player): MeasurableStore {
    const signer = toHex(player.publicKey);
    return {
      createProofAuthorized: async () => ({ signer }),
      submit: async (wire) => {
        const current = this.latestByChannel.get(wire.channel);
        if (current && current.expiry! >= wire.expiry) throw new Error(`statement rejected: {"status":"rejected","reason":"channelPriorityTooLow"}`);
        const statement = { data: wire.data, signer: (wire.proof as { signer: string }).signer, channel: wire.channel, expiry: wire.expiry, topics: wire.topics };
        this.latestByChannel.set(wire.channel, statement);
        this.submitted.push(wire);
        for (const subscriber of this.subscribers) {
          if (wire.topics.some((topic) => subscriber.topics.has(topic))) setTimeout(() => subscriber.onPage({ statements: [statement] }), 5);
        }
        return { status: "new" };
      },
      subscribe: (filter, onPage, events) => {
        const subscriber = { topics: new Set(filter.matchAny), onPage };
        this.subscribers.add(subscriber);
        events.opened();
        const statements = [...this.latestByChannel.values()].filter((statement) => statement.topics.some((topic) => subscriber.topics.has(topic)));
        if (statements.length > 0) setTimeout(() => onPage({ statements }), 5);
        return { unsubscribe: () => this.subscribers.delete(subscriber) };
      },
    };
  }
}

// The bots are what a load test puts on the statement store, so they must signal as the app's
// transport does and the counts the summary reads must follow what they sent and received.
describe("SignallingBot", () => {
  it("links every co-player in one room through the app's transport and counts every delivery", { timeout: 30_000 }, async () => {
    const memory = new MemoryStore();
    const stats = new SignallingStats();
    const players = [0, 1, 2].map((index) => derivePlayer("bot-test", index));
    const bots = players.map((player) => {
      const roster = players.filter((other) => other !== player).map((other) => other.address);
      return new SignallingBot({
        self: player.address,
        roster,
        namespace: "bot-test",
        profile: PROFILES.jollity,
        store: memory.storeOf(player),
        stats,
        window: { start: 0, end: Number.MAX_SAFE_INTEGER },
      });
    });
    const [late, ...early] = bots;
    for (const bot of early) bot.open();
    // Real time: the transport seals and deflates with the platform's WebCrypto and streams,
    // which fake timers don't drive. Links form within about 3 s of its debounces.
    await sleep(3_000);
    // The late player subscribes after the others replaced their first statements, so it receives
    // only the latest of each, which carries what the replaced ones did.
    late.open();
    await sleep(5_000);
    for (const bot of bots) bot.close();
    await sleep(500);
    for (const bot of bots) bot.leave();

    expect(stats.linksUp).toBe(6);
    expect(stats.links).toBe(6);
    expect(stats.submits.new).toBe(memory.submitted.length);
    expect(stats.acceptedInWindow).toBe(memory.submitted.length);
    expect(stats.expectedDeliveries).toBe(2 * memory.submitted.length);
    expect(stats.deliveredInWindow).toBeLessThan(stats.expectedDeliveries);
    const result = {
      layer: "signalling",
      runId: "bot-test",
      players: 3,
      shard: { index: 0, count: 1 },
      target: "memory",
      profile: PROFILES.jollity,
      window: { start: 0, end: Number.MAX_SAFE_INTEGER },
      lateMs: 0,
      stats,
      clientLoopDelayMs: { p50: 0, p99: 0, max: 0 },
    };
    const summary = summarizeStep([JSON.parse(JSON.stringify(result)) as SignallingShardResult], DEFAULT_THRESHOLDS);
    expect(summary.loss).toBe(0);
    expect(stats.latency.summary().count).toBe(stats.deliveredInWindow);
    // One statement per phone at a time, on its own channel, and the offers in them deflated and sealed.
    expect(new Set(memory.submitted.map((wire) => wire.channel)).size).toBe(3);
    expect(memory.submitted.some((wire) => wire.data.startsWith("0x01"))).toBe(true);
    expect(memory.submitted.some((wire) => Buffer.from(wire.data.slice(2), "hex").toString().includes("a=fingerprint"))).toBe(false);
  });
});
