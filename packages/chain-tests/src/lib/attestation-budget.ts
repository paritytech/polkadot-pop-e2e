/**
 * How long attesting a fresh account may take. No imports, so vitest.config.ts
 * can size its hook timeout from the same numbers the fixture waits on.
 */

/** truapi-host attest's own kill timer: backend calls, then ~2 min each for the dotNS name and the ring. */
export const ATTEST_TIMEOUT_MS = 480_000;

/**
 * The backend's search projection lags the chain; on a freshly spawned fork its
 * indexer starts cold, so the budget matches the engine's own registration e2e.
 */
export const SEARCH_TIMEOUT_MS = 240_000;

/** A fresh `ensureAttested()`, plus a minute so the fixture's attributed error throws before vitest's generic timeout. */
export const ATTESTATION_TIMEOUT_MS = ATTEST_TIMEOUT_MS + SEARCH_TIMEOUT_MS + 60_000;
