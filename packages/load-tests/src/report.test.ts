import { describe, expect, it, vi } from "vitest";
import { PROFILES } from "./profile.js";
import { DEFAULT_THRESHOLDS, summarizeStep } from "./report.js";
import type { SignallingShardResult } from "./signalling.js";
import { DeliveryCounter, STALL_MS, SignallingStats, countDeliveryGap, creditedDeliveries } from "./stats.js";
import { summarizeVideoGroups, videoMarkdown } from "./video/report.js";
import { VideoGroups, VideoStats } from "./video/stats.js";

function shard(index: number, accepted: number, delivered: number, lagMs = 10, record?: (stats: SignallingStats) => void): SignallingShardResult {
  const stats = new SignallingStats();
  record?.(stats);
  stats.subscribed += 50;
  stats.acceptedInWindow = accepted;
  // One game room of 100 players: each statement is due to the 99 others.
  stats.expectedDeliveries = accepted * 99;
  // The shard's statements on one channel, the deliveries spread over receivers up to the last of them.
  stats.acceptedExpiries[`channel ${index}`] = Array.from({ length: accepted }, (_, expiry) => String(expiry + 1));
  for (let receiver = 0; receiver * accepted < delivered; receiver++) {
    stats.deliveredUpTo[`shard ${index} receiver ${receiver}`] = { [`channel ${index}`]: String(Math.min(accepted, delivered - receiver * accepted)) };
  }
  stats.deliveredInWindow = delivered;
  stats.submits = { new: accepted };
  for (let i = 0; i < delivered; i++) stats.latency.add(40);
  // Shard results arrive at the summary as JSON, histograms included.
  return JSON.parse(
    JSON.stringify({
      layer: "signalling",
      runId: "test",
      players: 100,
      shard: { index, count: 2 },
      target: "test",
      profile: PROFILES.jollity,
      window: { start: 0, end: 151_000 },
      lateMs: 0,
      stats,
      clientLoopDelayMs: { p50: lagMs, p99: lagMs, max: lagMs },
    }),
  );
}

describe("summarizeStep", () => {
  it("passes a step whose every due delivery arrived across shards", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 990)], DEFAULT_THRESHOLDS);
    expect(summary.loss).toBe(0);
    expect(summary.verdict).toBe("pass");
  });

  it("fails a step that loses more than the threshold", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 900)], DEFAULT_THRESHOLDS);
    expect(summary.loss).toBeCloseTo(90 / 1980);
    expect(summary.verdict).toBe("fail");
  });

  // A submit that timed out at the client and was accepted late arrives without being counted as
  // sent: the counts are off, nothing was lost, so the step must not fail on it.
  it("notes more deliveries than were counted as sent without failing the step", () => {
    const late = shard(1, 10, 990);
    late.stats.deliveredInWindow = 1_000;
    const summary = summarizeStep([shard(0, 10, 990), late], DEFAULT_THRESHOLDS);
    expect(summary.verdict).toBe("pass");
    expect(summary.notes).toEqual(["delivery: more arrived than were counted as sent, so some submits that timed out were accepted late"]);
  });

  it("does not blame the target when a load process fell behind", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 900, 400)], DEFAULT_THRESHOLDS);
    expect(summary.verdict).toBe("inconclusive");
  });

  // A machine that died sends no result while the others still expect its bots' deliveries:
  // without this, a load machine's failure reads as the statement store losing messages.
  it("does not blame the target when a load machine sent no result", () => {
    const summary = summarizeStep([shard(0, 10, 500)], DEFAULT_THRESHOLDS);
    expect(summary.findings).toContain("client: 1 of 2 machines sent no result");
    expect(summary.verdict).toBe("inconclusive");
  });

  // statement-core's expiry floor carries a burst's expiries past the end of their second, so the
  // next statement on a channel can decode to an earlier time while its expiry still rises. The one
  // it replaced has to count as delivered with it, or the summary reads loss that didn't happen.
  it("credits a replaced statement when its successor decodes to an earlier time", () => {
    const stats = new SignallingStats();
    const sender = new DeliveryCounter(stats, { start: 0, end: 151_000 }, 1, "sender");
    const receiver = new DeliveryCounter(stats, { start: 0, end: 151_000 }, 1, "receiver");
    const first = { channel: "0xfloor", expiry: 0x7000_0000_0000_0001n, stampedAt: 1_000 };
    const second = { channel: "0xfloor", expiry: 0x7000_0000_0000_0002n, stampedAt: 500 };
    sender.accepted(first);
    sender.accepted(second);
    receiver.receive(second, 500, 600);
    // Shard results arrive at the summary as JSON, where a u64 expiry has to keep every digit.
    const merged = new SignallingStats();
    merged.add(JSON.parse(JSON.stringify(stats)));
    expect(merged.expectedDeliveries).toBe(2);
    expect(creditedDeliveries(merged)).toBe(2);
  });

  // A feed the node ends before it delivers anything is a subscription that never worked; one
  // that ends later is a reader dropped mid-game. The summary has to tell the two apart.
  it("reports how long ended subscriptions were open and how many ended before a statement", () => {
    vi.useFakeTimers({ now: 0 });
    const record = (stats: SignallingStats) => {
      const silent = new DeliveryCounter(stats, { start: 0, end: 151_000 }, 10, "silent");
      const delivering = new DeliveryCounter(stats, { start: 0, end: 151_000 }, 10, "delivering");
      silent.recordSubscribe();
      delivering.recordSubscribe();
      // a statement sent before the window: one statement delivered, no delivery counted
      delivering.receive({ channel: "early", expiry: 1n, stampedAt: -1 }, -1, 1_000);
      vi.advanceTimersByTime(30_000);
      silent.recordEnd("closed");
      delivering.recordEnd("closed");
    };
    const summary = summarizeStep([shard(0, 10, 990, 10, record), shard(1, 10, 990)], DEFAULT_THRESHOLDS);
    vi.useRealTimers();
    expect(summary.stats.emptySubscriptionEnds).toBe(1);
    expect(summary.subscriptionLifetimeMs.count).toBe(2);
    expect(summary.findings).toContainEqual(expect.stringContaining("2 subscriptions ended early, 1 of them before their first statement"));
  });
});

// A subscription that went quiet before the game ended is the store dropping a slow reader;
// one that never delivered points at the connection or the filter instead.
describe("countDeliveryGap", () => {
  const windowEnd = 200_000;
  it("tells a silent subscription from a stalled one and a live one", () => {
    const stats = new SignallingStats();
    countDeliveryGap(stats, 0, windowEnd);
    countDeliveryGap(stats, windowEnd - STALL_MS - 1, windowEnd);
    countDeliveryGap(stats, windowEnd - STALL_MS + 1, windowEnd);
    expect([stats.silentSubscriptions, stats.stalledSubscriptions]).toEqual([1, 1]);
  });
});

// A mixed run compares the bots that took TURN relay ports with those on STUN only.
describe("videoMarkdown", () => {
  it("adds a row per TURN group under the step's row when the step had both", () => {
    const groups = new VideoGroups();
    groups.withTurn.bots = 1;
    groups.withTurn.connectMs.add(20_000);
    groups.withTurn.candidateErrors = { "TURN server without a relay candidate": 3 };
    groups.withoutTurn.bots = 2;
    groups.withoutTurn.connectMs.add(500);
    const rows = videoMarkdown("test", [{ players: 3, video: summarizeVideoGroups(groups) }])
      .split("\n")
      .filter((line) => line.startsWith("| 3 |"));

    expect(rows.map((row) => row.split(" | ")[1])).toEqual(["all 3", "with TURN 1", "without TURN 2"]);
    expect(rows[1]).toContain("TURN server without a relay candidate 3");
    expect(rows[2]).not.toContain("TURN server without a relay candidate");

    groups.withoutTurn = new VideoStats();
    expect(videoMarkdown("test", [{ players: 3, video: summarizeVideoGroups(groups) }]).split("\n").filter((line) => line.startsWith("| 3 |"))).toHaveLength(1);
  });
});
