/**
 * On-demand fixture for tests that need an attested lite-person.
 *
 * Tests opt in by calling `await ensureAttested()` from their `beforeAll`.
 * The first call within a vitest run registers a fresh account via the
 * network's identity-backend and caches it to `.test-credentials.json`;
 * subsequent calls — from this test file OR any other in the same run —
 * read that file and return the cached account. Tests that don't need
 * an attested account never touch the IB at all by simply not importing
 * this module.
 *
 * Vitest loads each test file in its own module context, so the
 * in-memory cache doesn't carry across files; the on-disk file is the
 * authoritative reuse signal. CI guarantees freshness by deleting the
 * file before each run (`rm -f .test-credentials.json && pnpm test`);
 * local dev gets the same single-account benefit across iterative
 * `pnpm test` invocations until the file is manually cleared.
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchUsernameStatus,
  generateAttestationParams,
  signAndRegister,
} from "./attestation.js";
import { getNetworkConfig } from "../config/networks.js";
import type { AttestedCredentials } from "./credentials.js";

const CREDENTIALS_PATH = resolve(import.meta.dirname, "../../.test-credentials.json");

// Health-check runs every 30 min. The IB-health probe (tests/probes/ib-
// health.test.ts) runs FIRST via npm `test`-script ordering and calls
// `ensureAttested()` — its verdict gates every downstream suite that
// imports this module. 100 s gives ~50 polls of headroom over the ~30 s
// product expectation while staying well inside the per-attempt retry
// timeout (7 min).
//
// If you change this number, also update `_IB_ASSIGNED_BUDGET_SECONDS`
// in scripts/render-summary.py — the renderer cites this budget in the
// Matrix message so operators can correlate "IB took >N s" to the
// pollers' tolerance.
const ASSIGNED_TIMEOUT_MS = 100_000;
const ASSIGNED_POLL_INTERVAL_MS = 2_000;

function parseAttested(path: string): AttestedCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw.attested) return null;
    return {
      attested: true,
      address: raw.address,
      publicKey: Uint8Array.from(raw.publicKey),
      statementStoreSecret: Uint8Array.from(raw.statementStoreSecret),
      entropy: Uint8Array.from(raw.entropy),
      username: raw.username,
    };
  } catch {
    return null;
  }
}

let inflight: Promise<AttestedCredentials> | null = null;
// Permanent failure marker. vitest's poolOptions=singleFork keeps module
// state across test files within one run, so once the first ensureAttested
// call has determined IB is broken, every subsequent caller (in any later
// test file's beforeAll) can fail-fast off this rather than re-paying the
// 100s poll budget AND surfacing as a misleading "PGAS/Statement/Storage
// failed" signal. The cascaded failure carries an explicit prefix so the
// matrix-message renderer can group it under the IB-health line instead of
// listing it as an independent failure.
let cachedFailure: Error | null = null;
const IB_CASCADE_PREFIX =
  "[ib-cascade] Identity Backend attestation already failed earlier in this run — see Identity Backend Health probe for the real signal";

export function ensureAttested(): Promise<AttestedCredentials> {
  if (cachedFailure) return Promise.reject(cachedFailure);
  if (inflight) return inflight;
  inflight = doEnsureAttested().catch((err) => {
    inflight = null;
    // Tag the error so downstream consumers (and the report renderer) can
    // distinguish "IB is broken" from "the test of PGAS/Statement/etc. is
    // broken". The first failure carries the original attested-fixture
    // message; later callers see a short cascade marker.
    if (err instanceof Error && err.message.includes("[attested-fixture]")) {
      cachedFailure = new Error(`${IB_CASCADE_PREFIX}\n\nFirst failure was:\n${err.message}`);
    } else {
      cachedFailure = err instanceof Error ? err : new Error(String(err));
    }
    throw err;
  });
  return inflight;
}

async function doEnsureAttested(): Promise<AttestedCredentials> {
  const cached = parseAttested(CREDENTIALS_PATH);

  if (cached) {
    console.log(
      `[attested-fixture] Reusing ${cached.address} (${cached.username}) from .test-credentials.json`,
    );
    return cached;
  }

  const network = getNetworkConfig();
  if (!network.identityBackend) {
    throw new Error(
      `[attested-fixture] Network ${network.name} has no identityBackend configured`,
    );
  }

  console.log(`[attested-fixture] Network: ${network.name}`);
  console.log(`[attested-fixture] Identity backend: ${network.identityBackend}`);

  const { credentials, params } = generateAttestationParams();
  console.log(`[attested-fixture] Fresh account: ${credentials.address}`);
  console.log(`[attested-fixture] Username: ${params.username}`);

  const registerStart = Date.now();
  const result = await signAndRegister(
    network.identityBackend,
    credentials.entropy,
    params,
  );
  console.log(
    `[attested-fixture] Registered: ${result.username} (${Date.now() - registerStart}ms)`,
  );

  await waitForAssigned(network.identityBackend, result.username);

  const persisted: AttestedCredentials = {
    attested: true,
    address: credentials.address,
    publicKey: credentials.publicKey,
    statementStoreSecret: credentials.statementStoreSecret,
    entropy: credentials.entropy,
    username: result.username,
  };

  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({
      ...persisted,
      publicKey: Array.from(persisted.publicKey),
      statementStoreSecret: Array.from(persisted.statementStoreSecret),
      entropy: Array.from(persisted.entropy),
    }),
  );

  return persisted;
}

/**
 * Poll the IB for `username` until its status flips to `ASSIGNED`. Throws
 * with a precise message if the budget elapses — health-check picks this
 * up as the IB-health signal.
 */
async function waitForAssigned(backendUrl: string, username: string): Promise<void> {
  const start = Date.now();
  let polls = 0;
  let lastStatus: string | undefined;

  while (Date.now() - start < ASSIGNED_TIMEOUT_MS) {
    polls++;
    const iterationStart = Date.now();
    try {
      const entry = await fetchUsernameStatus(backendUrl, username);
      if (entry) {
        lastStatus = entry.status;
        if (entry.status === "ASSIGNED") {
          console.log(
            `[attested-fixture] ASSIGNED in ${Date.now() - start}ms (${polls} polls)`,
          );
          return;
        }
      }
    } catch (e: any) {
      console.log(`[attested-fixture] poll error: ${e.message}`);
    }
    const remaining = ASSIGNED_TIMEOUT_MS - (Date.now() - start);
    if (remaining <= 0) break;
    const sleepMs = Math.min(
      remaining,
      Math.max(0, ASSIGNED_POLL_INTERVAL_MS - (Date.now() - iterationStart)),
    );
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  }

  throw new Error(
    `[attested-fixture] ASSIGNED timeout — ${username} stuck at ${
      lastStatus ?? "unknown"
    } after ${Math.round((Date.now() - start) / 1000)}s (${polls} polls). ` +
      `IB reconciler is likely lagging; see Network Functional Health workflow history.`,
  );
}
