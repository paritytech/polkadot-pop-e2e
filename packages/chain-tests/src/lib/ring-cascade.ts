/**
 * Module-level cache for two related pieces of ring-lifecycle state,
 * shared across test files via vitest's `poolOptions=singleFork` +
 * `isolate: false`:
 *
 *   1) The People-chain ring-builder cascade verdict — populated by the
 *      `Ring Health` probe (or the `Ring Inclusion` probe, or
 *      `waitForInclusion` itself) when a chain-side fault is detected.
 *      Downstream suites read it via `assertRingBuilderHealthy()` and
 *      fail-fast with `[ring-cascade]`-prefixed attribution.
 *
 *   2) The freshly-attested test account's `MemberLocation` once the
 *      `Ring Inclusion` probe has confirmed the account made it into
 *      the lite-people ring. Downstream feature suites (PGAS, LTS) read
 *      this via `getCachedRingLocation()` instead of calling
 *      `waitForInclusion` themselves — so the multi-minute inclusion
 *      wait happens ONCE under a clearly-named probe test, not once per
 *      feature suite under feature-flavoured names.
 *
 * Why this cascade exists, in one sentence: when the individuality
 * offchain ring-builder worker on the People chain stalls (zero
 * `RingBuilt` events for tens of minutes, queue stuck at non-zero), every
 * feature test that registers a fresh account and then waits for ring
 * inclusion (PGAS claim, Statement Store write, LTS-allowance claim)
 * hangs for its full vitest timeout and reports "Test timed out" under
 * a name like "PGAS: claim + spend on revive" — making it look like a
 * PGAS bug. The actual cause is a chain-side fault that has nothing to
 * do with PGAS. With this cascade in place, the Ring Health / Ring
 * Inclusion probes run first, fail with the correct attribution, seed
 * the marker, and each downstream suite's `beforeAll` then throws a
 * short `[ring-cascade]` error in milliseconds.
 *
 * Pattern mirrors `chain-cascade.ts` exactly so they read identically.
 */

import type { MemberLocation } from "./ring.js";

let ringStuckReason: string | null = null;
let cachedRingLocation: MemberLocation | null = null;

export const RING_CASCADE_PREFIX = "[ring-cascade]";

/**
 * Record a chain-side ring-builder fault. Called by the Ring Health probe
 * when it detects a stuck builder, and by `waitForInclusion` when its
 * own poll budget expires — both paths produce a downstream cascade so
 * later tests can fail-fast with the correct attribution.
 */
export function markRingStuck(reason: string): void {
  // First write wins. The Ring Health probe runs ahead of feature suites
  // and produces the richest diagnostic; if `waitForInclusion` later also
  // times out and tries to mark, we keep the probe's verdict.
  if (ringStuckReason === null) {
    ringStuckReason = reason;
  }
}

export function getRingStuckReason(): string | null {
  return ringStuckReason;
}

/**
 * Throw a tagged cascade error if the Ring Health probe (or a prior
 * `waitForInclusion` timeout) determined the ring builder is stuck.
 * Call this near the top of `beforeAll` in any suite that registers a
 * fresh account and waits for ring inclusion — it fail-fasts in
 * milliseconds instead of burning the suite's IB-poll + ring-inclusion
 * budget against a chain that won't make progress anyway.
 *
 * The error message starts with `[ring-cascade]` and embeds the probe's
 * original verdict, so the on-call reading the matrix message sees
 * "ring builder stuck" attribution rather than test-internal wording.
 */
export function assertRingBuilderHealthy(): void {
  if (ringStuckReason !== null) {
    throw new Error(
      `${RING_CASCADE_PREFIX} People-chain ring builder reported stuck earlier in this run — ` +
        `see "Ring Health" / "Ring Inclusion" suite for the full diagnostic. Verdict was: ${ringStuckReason}`,
    );
  }
}

/**
 * Set by the `Ring Inclusion` probe once `waitForInclusion` returns for
 * the freshly-attested test account. Feature suites read this via
 * `getCachedRingLocation()` instead of re-running the multi-minute
 * inclusion wait themselves.
 */
export function setCachedRingLocation(location: MemberLocation): void {
  cachedRingLocation = location;
}

/**
 * Read the cached `MemberLocation` produced by the `Ring Inclusion`
 * probe. Returns `null` if the probe hasn't run (e.g. tests invoked
 * out of order, or the probe failed and the cascade marker was set
 * instead). Callers should pair this with `assertRingBuilderHealthy()`
 * earlier in `beforeAll` so a null here always means "test order is
 * wrong", not "chain is stuck".
 */
export function getCachedRingLocation(): MemberLocation | null {
  return cachedRingLocation;
}
