/**
 * The host side of the tests, run through the truapi-host CLI so the gate
 * exercises the same truapi core hosts ship: attestation, and the statement
 * allowance and PGAS claims. The CLI's preset chains are pointed at the stack's
 * endpoints and its identity backend.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { toHex } from "polkadot-api/utils";
import { getNetworkConfig, networkKey } from "../config/networks.js";
import { ATTEST_TIMEOUT_MS } from "./attestation-budget.js";

const run = promisify(execFile);

const PINNED_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
).devDependencies["@parity/truapi"];

const binary = () => process.env.TRUAPI_HOST_BIN ?? "truapi-host";

/** The dotNS TLD truapi derives the person's identities under on this network. */
export const networkSuffix = () => getNetworkConfig().tld;

function hostEnv(mnemonic: string): NodeJS.ProcessEnv {
  const network = getNetworkConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST_CLI_SIGNER_MNEMONIC: mnemonic,
    TRUAPI_HOST_NO_UPDATE: "1",
    // The preset's genesis hashes stay, so this only works on the preset's network or a fork of it.
    HOST_CLI_PEOPLE_WS: network.people.ws,
    HOST_CLI_ASSET_HUB_WS: network.assetHub.ws,
    HOST_CLI_BULLETIN_WS: network.bulletin.ws,
  };
  if (network.identityBackend) env.HOST_CLI_IDENTITY_BACKEND_BASE = `${network.identityBackend}/api/v1`;
  return env;
}

let pinnedCheck: Promise<void> | undefined;

/**
 * Fails, with the `[truapi-host-setup]` marker, unless the truapi-host the tests
 * run is the release package.json pins as `@parity/truapi`. Checked once per run.
 */
export function assertPinnedVersion(): Promise<void> {
  pinnedCheck ??= (async () => {
    const bin = binary();
    let version: string;
    try {
      const { stdout } = await run(bin, ["--version"], { env: { ...process.env, TRUAPI_HOST_NO_UPDATE: "1" } });
      version = stdout.trim();
    } catch (err: any) {
      throw new Error(`[truapi-host-setup] cannot run ${bin}: ${err.message}`);
    }
    if (version !== `truapi-host ${PINNED_VERSION}`) {
      throw new Error(`[truapi-host-setup] ${bin} is ${version}, but package.json pins @parity/truapi ${PINNED_VERSION}`);
    }
  })();
  return pinnedCheck;
}

async function truapiHost(mnemonic: string, args: string[], timeoutMs: number): Promise<string> {
  await assertPinnedVersion();
  if (!getNetworkConfig().features.identity) {
    throw new Error(`[truapi-host-setup] truapi-host doesn't have a CLI preset for network ${networkKey()}`);
  }
  const bin = binary();
  try {
    const { stdout } = await run(bin, [...args, "--network", networkKey()], {
      env: hostEnv(mnemonic),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const killed = err.killed ? ` (killed after ${timeoutMs / 1000}s)` : "";
    throw new Error(`[truapi-host] ${args[0]} failed${killed}: ${output || err.message}`);
  }
}

export interface AttestedIdentity {
  address: string;
  liteUsername: string;
}

/** Attests `mnemonic`'s identity and waits until it is a ring member. */
export async function attest(mnemonic: string, usernameBase: string): Promise<AttestedIdentity> {
  // Above attest's own worst case, so its error arrives before the kill does.
  const stdout = await truapiHost(mnemonic, ["attest", "--username", usernameBase], ATTEST_TIMEOUT_MS);
  let identity: Partial<AttestedIdentity> = {};
  try {
    identity = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {}
  if (!identity.address || !identity.liteUsername) {
    throw new Error(`[truapi-host-setup] attest printed no identity: ${stdout.trim()}`);
  }
  return identity as AttestedIdentity;
}

/** Registers `target` for a statement-store allowance from the person's ring membership. */
export async function claimStatementAllowance(mnemonic: string, target: Uint8Array): Promise<string> {
  return truapiHost(mnemonic, ["alloc-check", "--target", toHex(target), "--submit"], 240_000);
}

// Asset Hub imports People's ring revisions over XCM, which can outlast pgas-check's own wait.
const RING_REVISION_LAG = /Asset Hub (pruned|has not imported) ring/;
const PGAS_ATTEMPTS = 3;

/**
 * Claims the day's PGAS allowance, credited to `target`. Retries while Asset Hub
 * lags People's ring, and fails with the CLI's error once `deadline` passes.
 */
export async function claimPgas(mnemonic: string, target: Uint8Array, deadline: number): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("[truapi-host] pgas-check: no time left before the deadline");
    try {
      return await truapiHost(mnemonic, ["pgas-check", "--target", toHex(target), "--submit"], remaining);
    } catch (err) {
      if (attempt === PGAS_ATTEMPTS || !RING_REVISION_LAG.test((err as Error).message)) throw err;
      console.log(`[truapi-host] pgas-check: Asset Hub behind People's ring, retrying (${attempt}/${PGAS_ATTEMPTS})`);
    }
  }
}
