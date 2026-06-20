/**
 * Module-level cache for the freshly-attested test account's `MemberLocation`,
 * shared across test files via vitest's `poolOptions=singleFork` +
 * `isolate: false`.
 *
 * The `Ring Inclusion` probe runs once, pays the multi-minute ring-inclusion
 * wait under a clearly-named test, and caches the result here. Downstream
 * feature suites (PGAS, LTS, alias) read it via `getCachedRingLocation()`
 * instead of re-running the wait themselves — so the inclusion wait happens
 * ONCE, not once per feature suite.
 *
 * Historical note: this module also held a "ring builder stuck" cascade marker
 * that fail-fast-skipped every attestation-dependent suite when the People-chain
 * ring builder looked stuck. That gate was removed — it produced false cascades
 * (a single Ring Health verdict short-circuited the actual inclusion attempt
 * before it even ran, failing every dependent test), and genuine ring-builder
 * stalls are now surfaced by the monitor's `RingBuilderStalled` alert. Each
 * suite now runs on its own merits.
 */

import type { MemberLocation } from "./ring.js";

let cachedRingLocation: MemberLocation | null = null;

/**
 * Set by the `Ring Inclusion` probe once `waitForInclusion` returns for the
 * freshly-attested test account.
 */
export function setCachedRingLocation(location: MemberLocation): void {
  cachedRingLocation = location;
}

/**
 * Read the cached `MemberLocation` produced by the `Ring Inclusion` probe.
 * Returns `null` if the probe hasn't run (test order wrong) or its inclusion
 * wait failed. Callers handle null — either fail with a clear message
 * (allowances) or fall back to their own `waitForInclusion` (lts/alias claim).
 */
export function getCachedRingLocation(): MemberLocation | null {
  return cachedRingLocation;
}
