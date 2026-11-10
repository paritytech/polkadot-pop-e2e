import { describe, expect, it } from "vitest";
import { PROFILES } from "./profile.js";
import { DEFAULT_THRESHOLDS, summarizeStep } from "./report.js";
import type { SignallingShardResult } from "./signalling.js";
import { SignallingStats } from "./stats.js";

function shard(index: number, accepted: number, delivered: number, lagMs = 10): SignallingShardResult {
  const stats = new SignallingStats();
  stats.subscribed = 50;
  stats.acceptedInWindow = accepted;
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

// Every accepted statement is due to every other player in every shard: the verdict hangs on
// that count, so a wrong one passes a lossy target or fails a healthy one.
describe("summarizeStep", () => {
  it("expects each accepted statement at every other player across shards", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 990)], DEFAULT_THRESHOLDS);
    expect(summary.expectedDeliveries).toBe(20 * 99);
    expect(summary.loss).toBe(0);
    expect(summary.verdict).toBe("pass");
  });

  it("fails a step that loses more than the threshold", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 900)], DEFAULT_THRESHOLDS);
    expect(summary.loss).toBeCloseTo(90 / 1980);
    expect(summary.verdict).toBe("fail");
  });

  it("does not blame the target when a load process fell behind", () => {
    const summary = summarizeStep([shard(0, 10, 990), shard(1, 10, 900, 400)], DEFAULT_THRESHOLDS);
    expect(summary.verdict).toBe("inconclusive");
  });
});
