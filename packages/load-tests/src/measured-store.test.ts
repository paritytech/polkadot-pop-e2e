import { SIGN_TIMEOUT_MS, SUBMIT_TIMEOUT_MS, packExpiry, type WireStatement } from "@jollity/statement-core";
import { describe, expect, it, vi } from "vitest";
import { createCountingStore, stampTime, type MeasurableStore } from "./measured-store.js";
import { DeliveryCounter, SignallingStats } from "./stats.js";

// A receiver measures a statement's latency from the time its expiry was stamped at, which is
// the only send time the statement contains.
describe("stampTime", () => {
  it("reads the stamp time back from a packed expiry", () => {
    for (const ms of [1_790_000_000_123, 1_790_000_029_999, 4_294_967_296 * 417 + 5]) expect(stampTime(packExpiry(ms))).toBe(ms);
  });
});

// A host that never answers a proof or submit is a failure the players feel, so the summary has
// to count it rather than wait on it forever.
describe("createCountingStore", () => {
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
      const store = createCountingStore(hung, stats, new DeliveryCounter(stats, { start: 0, end: Number.MAX_SAFE_INTEGER }, 1, "player"));
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

  // Players of one process share statement-core's expiry floor, which stamps a statement later than
  // it went out, so a receiver in the process measures from when the sender sent it.
  it("measures a delivery from when the statement went out, not from its stamp", async () => {
    let deliver: ((page: { statements: Array<{ channel: string; expiry: bigint }> }) => void) | undefined;
    const store: MeasurableStore = {
      createProofAuthorized: async () => ({}),
      submit: async () => ({ status: "new" }),
      subscribe: (_filter, onPage) => {
        deliver = onPage;
        return { unsubscribe() {} };
      },
    };
    const stats = new SignallingStats();
    const window = { start: 0, end: Number.MAX_SAFE_INTEGER };
    const sender = createCountingStore(store, stats, new DeliveryCounter(stats, window, 1, "sender"));
    const receiver = createCountingStore(store, stats, new DeliveryCounter(stats, window, 1, "receiver"));
    receiver.subscribe({ matchAny: ["0x02"] }, () => {});
    const sentAt = Date.now();
    const stamped = { ...wire, channel: "0xAB", expiry: packExpiry(sentAt + 5_000) };
    await sender.createProofAuthorized(stamped);
    deliver!({ statements: [{ channel: "0xab", expiry: stamped.expiry }] });
    expect(stats.latency.summary().max).toBeGreaterThanOrEqual(0);
    expect(stats.latency.summary().max).toBeLessThan(1_000);
  });
});
