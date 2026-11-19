import { p256 } from "@noble/curves/nist.js";
import { toHex, type WireStatement } from "@jollity/statement-core";
import { describe, expect, it } from "vitest";
import { SignallingBot } from "./bot.js";
import { loadClip } from "./video/clip.js";
import { videoMarkdown } from "./video/report.js";
import { VideoStats } from "./video/stats.js";
import { coPlayersOf, roundsOf } from "./seating.js";
import type { SignallingProfile } from "./profile.js";
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

  // A real player's identifier on chain is the public key of a secret its phone keeps, which no bot
  // derives from its account: a bot that sealed to a derived one would never link with it.
  it("links a real player through the identifier it registered on chain", { timeout: 30_000 }, async () => {
    const memory = new MemoryStore();
    const stats = new SignallingStats();
    const [bot, person] = [0, 1].map((index) => derivePlayer("person-test", index));
    const secret = p256.utils.randomSecretKey();
    const optionsOf = (player: Player, other: Player) => ({
      self: player.address,
      roster: [other.address],
      namespace: "person-test",
      profile: PROFILES.jollity,
      store: memory.storeOf(player),
      stats,
      window: { start: 0, end: Number.MAX_SAFE_INTEGER },
    });
    const players = [
      new SignallingBot({ ...optionsOf(bot, person), identifiers: new Map([[person.address, p256.getPublicKey(secret, false)]]) }),
      new SignallingBot({ ...optionsOf(person, bot), secret }),
    ];
    for (const player of players) player.open();
    await sleep(4_000);
    for (const player of players) await player.close();
    for (const player of players) player.leave();

    expect(stats.linksUp).toBe(2);
  });

  // 12 bots are the fewest whose two rounds of 6 seat every bot with new co-players in round 2.
  it("plays video to the current group over real peer connections set up through the transport", { timeout: 60_000 }, async () => {
    const memory = new MemoryStore();
    const stats = new SignallingStats();
    const video = new VideoStats();
    const profile: SignallingProfile = { ...PROFILES.jollity, preconnectMs: 6_000, roundMs: 5_000, breakMs: 1_000 };
    const players = Array.from({ length: 12 }, (_, index) => derivePlayer("video-test", index));
    const clip = loadClip();
    const roomOpenAt = Date.now();
    const bots = players.map((player, index) => {
      const addressOf = (other: number) => players[other].address;
      return new SignallingBot({
        self: player.address,
        roster: coPlayersOf(index, players.length, profile).map(addressOf),
        namespace: "video-test",
        profile,
        store: memory.storeOf(player),
        stats,
        window: { start: 0, end: Number.MAX_SAFE_INTEGER },
        video: {
          rounds: roundsOf(index, players.length, profile, roomOpenAt, addressOf),
          clip,
          ice: { stunUrls: [], turn: [], relay: false, interfaceAddress: "127.0.0.1" },
          stats: video,
        },
      });
    });
    for (const bot of bots) bot.open();
    // Past the switch to the second round's groups at 11 s, with time for its keyframes.
    await sleep(16_000);
    await Promise.all(bots.map((bot) => bot.close()));
    for (const bot of bots) bot.leave();

    expect(stats.linksUp).toBe(stats.links);
    expect(video.linksWithVideo).toBe(stats.links);
    expect(video.candidateTypes).toEqual({ host: stats.links });
    // One loopback host candidate per link and side, sent in the description and received by the co-player.
    expect(video.localCandidates).toEqual({ host: stats.links });
    expect(video.remoteCandidates).toEqual({ host: stats.links });
    expect(video.candidateErrors).toEqual({});
    expect(video.failures).toEqual({});
    // Each round's group sends both ways, and a group that starts in the second round starts
    // mid-GOP, so its first frame comes from a PLI served with the next IDR.
    expect(video.streamsWithFrames).toBe(video.streams);
    expect(video.pliSent).toBeGreaterThan(0);
    expect(video.pliReceived).toBeGreaterThan(0);
    expect(video.keyframesForced).toBeGreaterThan(0);
    expect(video.packetsLost).toBe(0);
    const result = {
      layer: "signalling",
      runId: "video-test",
      players: players.length,
      shard: { index: 0, count: 1 },
      target: "memory",
      profile,
      window: { start: 0, end: Number.MAX_SAFE_INTEGER },
      lateMs: 0,
      stats,
      clientLoopDelayMs: { p50: 0, p99: 0, max: 0 },
      video,
    };
    const summary = summarizeStep([JSON.parse(JSON.stringify(result)) as SignallingShardResult], DEFAULT_THRESHOLDS);
    console.log(videoMarkdown("memory", [{ players: players.length, video: summary.video! }]));
    // Over 1 would mean frames from a co-player on standby, whose camera should be off.
    expect(summary.video?.frameShare).toBeGreaterThan(0.9);
    expect(summary.video?.frameShare).toBeLessThan(1.05);
    expect(summary.findings.filter((finding) => /^(video|TURN)/.test(finding))).toEqual([]);
  });
});
