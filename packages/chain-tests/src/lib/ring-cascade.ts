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
 *
 * Key drift is the one failure cached here: when People has no member for the
 * key we derive, no later wait can find it, so every suite fails at once with
 * the probe's error instead of each waiting out its own timeout.
 */

import type { MemberLocation } from "./ring.js";

let cachedRingLocation: MemberLocation | null = null;
let ringKeyDrift: Error | null = null;

/**
 * Set by the `Ring Inclusion` probe when People has no member for the locally
 * derived key, though truapi-host attest saw the account in a ring.
 */
export function setRingKeyDrift(err: Error): void {
  ringKeyDrift = err;
}

/**
 * Set by the `Ring Inclusion` probe once `waitForInclusion` returns for the
 * freshly-attested test account.
 */
export function setCachedRingLocation(location: MemberLocation): void {
  cachedRingLocation = location;
}

/**
 * The `MemberLocation` the `Ring Inclusion` probe found, or `null` if the probe
 * hasn't run or failed; callers then run `waitForInclusion` themselves.
 * Throws the probe's error once it has found key drift.
 */
export function getCachedRingLocation(): MemberLocation | null {
  if (ringKeyDrift) throw ringKeyDrift;
  return cachedRingLocation;
}
