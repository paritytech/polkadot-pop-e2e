import { packExpiry } from "@jollity/statement-core";
import { describe, expect, it } from "vitest";
import { stampTime } from "./measured-store.js";

// A receiver measures a statement's latency from the time its expiry was stamped at, which is
// all the statement says of when it was sent.
describe("stampTime", () => {
  it("reads the stamp time back from a packed expiry", () => {
    for (const ms of [1_790_000_000_123, 1_790_000_029_999, 4_294_967_296 * 417 + 5]) expect(stampTime(packExpiry(ms))).toBe(ms);
  });
});
