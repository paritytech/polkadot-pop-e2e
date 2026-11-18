import { SIGN_TIMEOUT_MS, SUBMIT_TIMEOUT_MS, packExpiry, type WireStatement } from "@jollity/statement-core";
import { describe, expect, it, vi } from "vitest";
import { measuredStore, stampTime, type MeasurableStore } from "./measured-store.js";
import { DeliveryCounter, SignallingStats } from "./stats.js";

// A receiver measures a statement's latency from the time its expiry was stamped at, which is
// all the statement says of when it was sent.
describe("stampTime", () => {
  it("reads the stamp time back from a packed expiry", () => {
    for (const ms of [1_790_000_000_123, 1_790_000_029_999, 4_294_967_296 * 417 + 5]) expect(stampTime(packExpiry(ms))).toBe(ms);
  });
});

// A host that never answers a proof or submit is a failure the players feel, so the summary has
// to count it rather than wait on it forever.
describe("measuredStore", () => {
  const hung: MeasurableStore = {
    createProofAuthorized: () => new Promise(() => {}),
    submit: () => new Promise(() => {}),
    subscribe: () => ({ unsubscribe() {} }),
  };
  const wire = { expiry: packExpiry(Date.now()), channel: "0x01", topics: ["0x02"], data: "0x03" } as WireStatement;

  it("counts a proof and a submit that never answer as timeouts", async () => {
    vi.useFakeTimers();
    try {
      const stats = new SignallingStats();
      const store = measuredStore(hung, stats, new DeliveryCounter(stats, { start: 0, end: Number.MAX_SAFE_INTEGER }, 1));
      const proof = expect(store.createProofAuthorized(wire)).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS);
      await proof;
      const submit = expect(store.submit({ ...wire, proof: {} })).rejects.toThrow("timeout");
      await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);
      await submit;
      expect(stats.submits).toEqual({ "proof:timeout": 1, "submit:timeout": 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
