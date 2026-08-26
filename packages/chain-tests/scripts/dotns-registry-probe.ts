/**
 * DotNS registry probe — "what TLD does this network declare, and which
 * products are actually registered on it?"
 *
 * Run this first whenever a network is rebuilt and the app-tests suite goes
 * red everywhere. It separates two failure modes that look identical in a
 * Playwright log:
 *
 *   1. the harness is asking for the wrong name (wrong TLD), and
 *   2. the name is right but the product was never redeployed.
 *
 * The TLD stopped being a constant in paritytech/dotns#218 — it now lives on
 * `DotnsProtocolRegistry` and each network initialises its own, so `.dot` is
 * no longer a safe assumption. `src/helpers/dotns.ts` in app-tests mirrors
 * this mapping statically; this probe is how you check the mirror is right.
 *
 * Usage:
 *   pnpm --filter @pop-e2e/chain-tests probe:dotns
 *   NETWORK=previewnet pnpm --filter @pop-e2e/chain-tests probe:dotns
 *
 * Reads only (`view` calls via dry-run), so the signing account needs an
 * address but no funds.
 *
 * Addresses are CREATE3-derived and therefore identical on every network
 * (paritytech/dotns DEPLOYMENTS.md → "Live addresses"), so they are constants
 * here rather than per-network config.
 */
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { namehash } from "viem";
import { createAssetHubClient } from "../src/lib/client.js";
import { createTestAccount } from "../src/lib/signer.js";
import { performContractCall } from "../src/lib/contract.js";
import { getNetworkConfig } from "../src/config/networks.js";

const PROTOCOL_REGISTRY = "0xD19e3D0C97CF501125a04A97405e3e6592fa846E";
const DOTNS_REGISTRY = "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA";

const TLD_ABI = [
  {
    inputs: [],
    name: "tld",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

const RECORD_EXISTS_ABI = [
  {
    inputs: [{ name: "node", type: "bytes32" }],
    name: "recordExists",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
];

/** Every product label the app-tests suite drives, by bare label. */
const PRODUCT_LABELS = [
  "host-playground",
  "browse",
  "t3rminal",
  "web3summit",
  "web3summit-admin",
  "linktr33app99",
];

async function main() {
  const network = getNetworkConfig();
  console.log(`[dotns-probe] network:  ${network.name}`);
  console.log(`[dotns-probe] assetHub: ${network.assetHub.ws}`);

  const { client, api } = createAssetHubClient(network.assetHub.ws);
  const account = await createTestAccount();

  try {
    let suffix: string;
    try {
      const tld = await performContractCall<string>(
        api, client, account.address,
        PROTOCOL_REGISTRY, TLD_ABI, "tld", [],
      );
      suffix = tld.startsWith(".") ? tld : `.${tld}`;
      console.log(`[dotns-probe] tld():    ${JSON.stringify(tld)}`);
    } catch (e) {
      // A revert here means the registry at this address predates dotns#218
      // (no `tld()`) or was never initialised on this network. Say that,
      // rather than guessing a suffix — a wrong guess reports every product
      // as unregistered and sends the reader chasing a deploy that is fine.
      console.log(
        `[dotns-probe] tld() unavailable: ${(e as Error).message.slice(0, 140)}`,
      );
      console.log(
        `[dotns-probe] registry at ${PROTOCOL_REGISTRY} looks pre-#218 or ` +
          `uninitialised here — not guessing a suffix, so no product lookups.`,
      );
      return;
    }

    console.log("");
    for (const label of PRODUCT_LABELS) {
      const name = `${label}${suffix}`;
      try {
        const exists = await performContractCall<boolean>(
          api, client, account.address,
          DOTNS_REGISTRY, RECORD_EXISTS_ABI, "recordExists", [namehash(name)],
        );
        console.log(`[dotns-probe] ${exists ? "registered     " : "NOT REGISTERED "} ${name}`);
      } catch (e) {
        console.log(`[dotns-probe] lookup failed   ${name}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  } finally {
    client.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
