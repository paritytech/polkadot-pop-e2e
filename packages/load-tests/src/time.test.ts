import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryUntil } from "./time.js";

// A chain run follows its game for hours over a public node: a read the node doesn't answer once
// must cost a retry, not the run, and only a node that stays silent past the wait ends it.
describe("retryUntil", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads again after failures, backing off, until a read is answered", async () => {
    let reads = 0;
    const retries: Array<[number, number]> = [];
    const value = retryUntil(
      async () => {
        if (++reads < 4) throw new Error("chain time read: no answer in 30 s");
        return 42;
      },
      600_000,
      (_error, attempt, pauseMs) => retries.push([attempt, pauseMs]),
    );
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(value).resolves.toBe(42);
    expect(retries).toEqual([
      [1, 1_000],
      [2, 2_000],
      [3, 4_000],
    ]);
  });

  it("fails once the wait has passed, with how many reads it took", async () => {
    const value = retryUntil(
      async () => {
        throw new Error("chain time read: no answer in 30 s");
      },
      60_000,
      () => {},
    );
    const failure = expect(value).rejects.toThrow("chain time read: no answer in 30 s, 7 reads over 60 s");
    await vi.advanceTimersByTimeAsync(120_000);
    await failure;
  });
});
