import { toHex, type WireStatement } from "@jollity/statement-core";
import { describe, expect, it } from "vitest";
import { SignallingBot } from "./bot.js";
import { derivePlayer, type Player } from "./keys.js";
import type { DeliveredStatement, MeasurableStore } from "./measured-store.js";
import { PROFILES } from "./profile.js";
import { DeliveryCounter, SignallingStats } from "./stats.js";
import { sleep } from "./time.js";

/** A statement store in memory: one statement per channel, each delivered to the subscribers of its topic. */
class MemoryStore {
  readonly submitted: WireStatement[] = [];
  private readonly held = new Map<string, DeliveredStatement & { topics: string[] }>();
  private readonly subscribers = new Set<{ topics: Set<string>; onPage(page: { statements: DeliveredStatement[] }): void }>();

  storeOf(player: Player): MeasurableStore {
    const signer = toHex(player.publicKey);
    return {
      createProofAuthorized: async () => ({ signer }),
      submit: async (wire) => {
        const held = this.held.get(wire.channel);
        if (held && held.expiry! >= wire.expiry) throw new Error(`statement rejected: {"status":"rejected","reason":"channelPriorityTooLow"}`);
        const statement = { data: wire.data, signer: (wire.proof as { signer: string }).signer, channel: wire.channel, expiry: wire.expiry, topics: wire.topics };
        this.held.set(wire.channel, statement);
        this.submitted.push(wire);
        for (const subscriber of this.subscribers) {
          if (wire.topics.some((topic) => subscriber.topics.has(topic))) setTimeout(() => subscriber.onPage({ statements: [statement] }), 5);
        }
        return { status: "new" };
      },
      subscribe: (filter, onPage) => {
        const subscriber = { topics: new Set(filter.matchAny), onPage };
        this.subscribers.add(subscriber);
        return { unsubscribe: () => this.subscribers.delete(subscriber) };
      },
    };
  }
}

// The bots are what a load test puts on the statement store, so they must signal as the app's
// transport does and the counts the summary reads must follow what they sent and received.
describe("SignallingBot", () => {
  it("links every co-player in one room through the app's transport and counts every delivery", { timeout: 20_000 }, async () => {
    const memory = new MemoryStore();
    const stats = new SignallingStats();
    const players = [0, 1, 2].map((index) => derivePlayer("bot-test", index));
    const bots = players.map((player) => {
      const roster = players.filter((other) => other !== player).map((other) => other.address);
      const counter = new DeliveryCounter(stats, { start: 0, end: Number.MAX_SAFE_INTEGER }, roster.length);
      counter.recordSubscribe();
      return new SignallingBot({ self: player.address, roster, namespace: "bot-test", profile: PROFILES.jollity, store: memory.storeOf(player), stats, counter });
    });
    for (const bot of bots) bot.open();
    // Real time: the transport seals and deflates with the platform's WebCrypto and streams,
    // which fake timers don't drive. Links form within about 3 s of its debounces.
    await sleep(5_000);
    for (const bot of bots) bot.close();
    await sleep(500);
    for (const bot of bots) bot.leave();

    expect(stats.linksUp).toBe(6);
    expect(stats.links).toBe(6);
    expect(stats.submits.new).toBe(memory.submitted.length);
    expect(stats.acceptedInWindow).toBe(memory.submitted.length);
    expect(stats.expectedDeliveries).toBe(2 * memory.submitted.length);
    expect(stats.deliveredInWindow).toBe(stats.expectedDeliveries);
    expect(stats.latency.summary().count).toBe(stats.deliveredInWindow);
    // One statement per phone at a time, on its own channel, and the offers in them deflated and sealed.
    expect(new Set(memory.submitted.map((wire) => wire.channel)).size).toBe(3);
    expect(memory.submitted.some((wire) => wire.data.startsWith("0x01"))).toBe(true);
    expect(memory.submitted.some((wire) => Buffer.from(wire.data.slice(2), "hex").toString().includes("a=fingerprint"))).toBe(false);
  });
});
