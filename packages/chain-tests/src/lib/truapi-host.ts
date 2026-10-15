/**
 * The host side of the tests, run through the truapi-host CLI so the gate
 * exercises the same truapi core hosts ship: attestation, and the statement
 * allowance and PGAS claims. On a fork the CLI's preset chains are pointed at
 * the fork's endpoints and its identity backend.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toHex } from "polkadot-api/utils";
import { getNetworkConfig } from "../config/networks.js";

const run = promisify(execFile);

/** CLI presets, with the dotNS TLD each derives identities under. */
const PRESETS = {
  previewnet: "testnet",
  "paseo-next-v2": "paseo",
} as const;
type Preset = keyof typeof PRESETS;

function preset(): Preset {
  const name = process.env.NETWORK === "local-fork" ? (process.env.FORK_OF ?? "previewnet") : process.env.NETWORK;
  const network = name ?? "paseo-next-v2";
  if (!(network in PRESETS)) throw new Error(`[truapi-host] no CLI preset for network ${network}`);
  return network as Preset;
}

/** The dotNS TLD truapi derives the person's identities under on this network. */
export const networkSuffix = () => PRESETS[preset()];

function hostEnv(mnemonic: string): NodeJS.ProcessEnv {
  const network = getNetworkConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST_CLI_SIGNER_MNEMONIC: mnemonic,
    TRUAPI_HOST_NO_UPDATE: "1",
  };
  if (network.identityBackend) env.HOST_CLI_IDENTITY_BACKEND_BASE = `${network.identityBackend}/api/v1`;
  if (process.env.NETWORK === "local-fork") {
    env.HOST_CLI_PEOPLE_WS = network.people.ws;
    env.HOST_CLI_ASSET_HUB_WS = network.assetHub.ws;
    env.HOST_CLI_BULLETIN_WS = network.bulletin.ws;
  }
  return env;
}

async function truapiHost(mnemonic: string, args: string[], timeoutMs: number): Promise<string> {
  const bin = process.env.TRUAPI_HOST_BIN ?? "truapi-host";
  try {
    const { stdout } = await run(bin, [...args, "--network", preset()], {
      env: hostEnv(mnemonic),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`[truapi-host] ${args[0]} failed: ${output || err.message}`);
  }
}

export interface AttestedIdentity {
  address: string;
  publicKey: string;
  liteUsername: string;
}

/** Attests `mnemonic`'s identity and waits until it is a ring member. */
export async function attest(mnemonic: string, usernameBase: string): Promise<AttestedIdentity> {
  const stdout = await truapiHost(mnemonic, ["attest", "--username", usernameBase], 300_000);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as AttestedIdentity;
}

/** Registers `target` for a statement-store allowance from the person's ring membership. */
export async function claimStatementAllowance(mnemonic: string, target: Uint8Array): Promise<string> {
  return truapiHost(mnemonic, ["alloc-check", "--target", toHex(target), "--submit"], 240_000);
}

/** Claims the day's PGAS allowance, credited to `target`. */
export async function claimPgas(mnemonic: string, target: Uint8Array): Promise<string> {
  return truapiHost(mnemonic, ["pgas-check", "--target", toHex(target), "--submit"], 240_000);
}
