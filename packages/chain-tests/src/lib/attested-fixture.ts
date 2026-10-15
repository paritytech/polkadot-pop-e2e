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
import { generateMnemonic, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { getNetworkConfig } from "../config/networks.js";
import { attest, networkSuffix } from "./truapi-host.js";
import type { AttestedCredentials } from "./credentials.js";

const CREDENTIALS_PATH = resolve(import.meta.dirname, "../../.test-credentials.json");

// The backend's search projection lags the chain; on a freshly spawned fork its
// indexer starts cold, so the budget matches the engine's own registration e2e.
const SEARCH_TIMEOUT_MS = 240_000;
const SEARCH_POLL_INTERVAL_MS = 5_000;

function parseAttested(path: string): AttestedCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Credentials from another network, or from before truapi-host attested them, are not reused.
    if (!raw.attested || !raw.mnemonic || raw.networkSuffix !== networkSuffix()) return null;
    return {
      attested: true,
      mnemonic: raw.mnemonic,
      networkSuffix: raw.networkSuffix,
      address: raw.address,
      publicKey: Uint8Array.from(raw.publicKey),
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

/**
 * Capability check: does the active network advertise an Identity Backend
 * we can attest against? Use this in `describe.skipIf` / `it.skipIf` to
 * skip attestation-dependent tests cleanly on networks where IB isn't
 * deployed yet — same pattern as `features.pgas` for Revive-paid tests.
 *
 * Treat IB presence as a capability, not a hard requirement: a missing IB
 * is a known-network-state, not a test failure. Tests that bypass this
 * gate and call `ensureAttested()` directly will still throw a loud error
 * (see below) so the omission shows up as a fixable bug, not a silent skip.
 */
export function needsAttestation(): boolean {
  return getNetworkConfig().identityBackend !== null;
}

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
    // Reaching this branch means a test forgot to gate itself with
    // `needsAttestation()` / `describe.skipIf(!needsAttestation())`. Loud
    // throw is the desired behavior — the gate is the contract.
    throw new Error(
      `[attested-fixture] Network ${network.name} has no identityBackend configured. ` +
        "Gate attestation-dependent tests with `describe.skipIf(!needsAttestation())` " +
        "or `it.skipIf(!needsAttestation())`.",
    );
  }

  console.log(`[attested-fixture] Network: ${network.name}`);
  console.log(`[attested-fixture] Identity backend: ${network.identityBackend}`);

  const mnemonic = generateMnemonic(128);
  const usernameBase = `etest${randomLetters(8)}`;
  const start = Date.now();
  const identity = await attest(mnemonic, usernameBase).catch((err: Error) => {
    throw new Error(`[attested-fixture] ${err.message}`);
  });
  console.log(
    `[attested-fixture] truapi-host attested ${identity.address} as ${identity.liteUsername} ` +
      `(${Date.now() - start}ms)`,
  );

  await waitForSearchable(network.identityBackend, identity.liteUsername);

  const persisted: AttestedCredentials = {
    attested: true,
    mnemonic,
    networkSuffix: networkSuffix(),
    address: identity.address,
    publicKey: Uint8Array.from(Buffer.from(identity.publicKey.slice(2), "hex")),
    entropy: mnemonicToEntropy(mnemonic),
    username: identity.liteUsername,
  };

  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({
      ...persisted,
      publicKey: Array.from(persisted.publicKey),
      entropy: Array.from(persisted.entropy),
    }),
  );

  return persisted;
}

function randomLetters(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b % 26))).join("");
}

/**
 * GET /api/v1/usernames/search?prefix= — IBv2's indexer projection, which hosts
 * use to find people by username.
 */
async function searchUsername(backendUrl: string, username: string): Promise<boolean> {
  const res = await fetch(
    `${backendUrl}/api/v1/usernames/search?prefix=${encodeURIComponent(username)}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return false;
  const body = (await res.json()) as { usernames?: Array<{ username: string }> };
  return !!body.usernames?.some((u) => u.username === username);
}

/**
 * truapi-host returns once the username is on chain and the person is in a
 * ring; the backend's search is checked separately because hosts read it too.
 */
async function waitForSearchable(backendUrl: string, username: string): Promise<void> {
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < SEARCH_TIMEOUT_MS) {
    polls++;
    try {
      if (await searchUsername(backendUrl, username)) {
        console.log(`[attested-fixture] searchable in ${Date.now() - start}ms`);
        return;
      }
    } catch (e: any) {
      console.log(`[attested-fixture] search poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, SEARCH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `[attested-fixture] ${username} never reached the backend's search within ` +
      `${SEARCH_TIMEOUT_MS / 1000}s (${polls} polls) — check the backend's indexer log`,
  );
}
