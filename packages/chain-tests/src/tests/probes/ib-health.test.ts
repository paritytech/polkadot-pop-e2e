/**
 * Identity Backend health probe — runs FIRST and gates the rest of the suite.
 *
 * Attests a fresh lite-person through truapi-host against the network's
 * identity-backend, then waits for its username in the backend's search
 * (budgets in attested-fixture.ts). Pass → the generated account is cached in module state for every
 * downstream suite that calls `ensureAttested()`; fail → the cached
 * failure short-circuits each downstream `beforeAll` in milliseconds
 * with an `[ib-cascade]` marker that the matrix-failures renderer
 * groups under a single "Identity Backend attestation degraded" line.
 *
 * Two things make the gating work end-to-end:
 *
 *   1. vitest is configured with `poolOptions.forks.singleFork: true`,
 *      so all test files run in one process and module state (including
 *      the `inflight` / `cachedFailure` in attested-fixture.ts) is
 *      shared across files.
 *
 *   2. The npm `test` script enumerates this file FIRST on the vitest
 *      CLI. With `sequence.shuffle: false` (vitest default), files run
 *      in CLI order — so this probe runs before any suite whose
 *      `beforeAll` calls `ensureAttested()`.
 *
 * Together: the probe is the single test whose NAME tells the operator
 * what's broken when IB is broken, and the same call that produces that
 * verdict also generates the session account every downstream test
 * needs. One IB round-trip per CI run, one Matrix line per outage.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ensureAttested, needsAttestation } from "../../lib/attested-fixture.js";
import { assertChainHealthy } from "../../lib/chain-cascade.js";
import { getNetworkConfig } from "../../config/networks.js";

// truapi-host attest (480 s) plus the backend search wait (240 s), so the
// fixture's attributed error throws before vitest's generic timeout.
const ATTESTATION_TIMEOUT_MS = 780_000;

describe("Identity Backend Health", () => {
  beforeAll(() => {
    // IB writes attestation results to People — if People is dead the
    // registration will never land. Cascade out instead of burning the
    // attestation budget.
    assertChainHealthy("people");

    const network = getNetworkConfig();
    console.log(`[ib-health] Network: ${network.name}`);
    console.log(`[ib-health] Identity Backend: ${network.identityBackend ?? "none"}`);
  });

  it.skipIf(!needsAttestation())(
    "attests a fresh account and finds its username in the backend's search",
    async () => {
      const creds = await ensureAttested();
      expect(creds.attested).toBe(true);
      expect(creds.username).toMatch(/.+/);
      console.log(`[ib-health] OK — ${creds.username} attested and searchable`);
    },
    ATTESTATION_TIMEOUT_MS,
  );
});
