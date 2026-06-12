/**
 * Idempotent deployer for the test counter contracts on Asset Hub:
 *
 *   1. Counter       — used by `allowances.test.ts` (PGAS-paid call test).
 *   2. PopCounter    — used by `pop-gate.test.ts` (PoP-gated calls).
 *
 * For each contract:
 *   - Compute the EVM code_hash from its runtime bytecode.
 *   - Search `Revive.AccountInfoOf` for any contract with that code_hash;
 *     skip the deploy if one is already present.
 *   - Otherwise check `Revive.PristineCode[codeHash]`. If uploaded, call
 *     `Revive.instantiate`. If not, call `Revive.instantiate_with_code`.
 *
 * Sign with `network.testAccountUri` (e.g. `//Alice` on previewnet) or
 * `TEST_MNEMONIC` env. The deployer must have native funds on Asset
 * Hub — PGAS pays for the *call*, not the deploy.
 *
 * Run before tests:
 *   NETWORK=previewnet pnpm deploy-counter
 */
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

import { createClient, Binary, type SizedHex, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getNetworkConfig } from "../src/config/networks.js";
import { descriptorsForNetwork, createAssetHubClient, type AssetHubApi } from "../src/lib/client.js";
import {
  COUNTER_BYTECODE_HEX,
  COUNTER_CODE_HASH,
  findCounterContract,
  toHex,
} from "../src/lib/counter-contract.js";
import {
  POP_COUNTER_BYTECODE_HEX,
  POP_COUNTER_CODE_HASH,
  findPopCounterContract,
} from "../src/lib/pop-counter-contract.js";

async function deployIfMissing(args: {
  label: string;
  api: AssetHubApi;
  signer: PolkadotSigner;
  bytecodeHex: string;
  codeHash: Uint8Array;
  existing: SizedHex<20> | null;
}): Promise<SizedHex<20>> {
  if (args.existing) {
    console.log(`[deploy-counter] ${args.label} already at ${args.existing} — skipping.`);
    return args.existing;
  }
  const codeHashHex = toHex(args.codeHash) as SizedHex<32>;
  const pristine = await args.api.query.Revive.PristineCode.getValue(codeHashHex);
  let result;
  if (pristine) {
    console.log(`[deploy-counter] ${args.label}: code already uploaded — instantiate.`);
    const tx = args.api.tx.Revive.instantiate({
      value: 0n,
      weight_limit: { ref_time: 5_000_000_000n, proof_size: 200_000n },
      storage_deposit_limit: 1_000_000_000_000n,
      code_hash: codeHashHex,
      data: Binary.fromHex("0x"),
      salt: undefined,
    });
    result = await tx.signAndSubmit(args.signer);
  } else {
    console.log(`[deploy-counter] ${args.label}: first-time upload + instantiate.`);
    const tx = args.api.tx.Revive.instantiate_with_code({
      value: 0n,
      weight_limit: { ref_time: 5_000_000_000n, proof_size: 200_000n },
      storage_deposit_limit: 1_000_000_000_000n,
      code: Binary.fromHex("0x" + args.bytecodeHex),
      data: Binary.fromHex("0x"),
      salt: undefined,
    });
    result = await tx.signAndSubmit(args.signer);
  }
  if (!result.ok) {
    throw new Error(
      `[deploy-counter] ${args.label} deploy failed: dispatchError=${JSON.stringify(result.dispatchError)}`,
    );
  }
  const instantiated = result.events?.find(
    (e: { type: string; value: { type: string } }) =>
      e.type === "Revive" && e.value?.type === "Instantiated",
  ) as { value: { value: { contract: SizedHex<20> } } } | undefined;
  if (!instantiated) {
    throw new Error(`[deploy-counter] ${args.label}: no Revive.Instantiated event`);
  }
  const addr = instantiated.value.value.contract;
  console.log(`[deploy-counter] ${args.label} deployed at ${addr} block=#${result.block.number}`);
  return addr;
}

async function main() {
  await cryptoWaitReady();
  const network = getNetworkConfig();
  console.log(`[deploy-counter] Network: ${network.name}`);
  console.log(`[deploy-counter] Counter code_hash: ${toHex(COUNTER_CODE_HASH)}`);
  console.log(`[deploy-counter] PopCounter code_hash: ${toHex(POP_COUNTER_CODE_HASH)}`);

  const { client, api } = createAssetHubClient(network.assetHub.ws);
  void descriptorsForNetwork; // re-export sanity — also used elsewhere

  // Pick a funded deployer — same resolution as chain-tests' funded ops:
  //   1. `network.testAccountUri` (e.g. `//Alice` on previewnet)
  //   2. `TEST_MNEMONIC` env (CI secret)
  const keyring = new Keyring({ type: "sr25519" });
  let account: ReturnType<typeof keyring.addFromUri>;
  let source: string;
  if (network.testAccountUri) {
    account = keyring.addFromUri(network.testAccountUri);
    source = `network.testAccountUri=${network.testAccountUri}`;
  } else if (process.env.TEST_MNEMONIC) {
    account = keyring.addFromMnemonic(process.env.TEST_MNEMONIC);
    source = `TEST_MNEMONIC (mnemonic)`;
  } else {
    throw new Error(
      "[deploy-counter] No deployer key available. Set network.testAccountUri or TEST_MNEMONIC.",
    );
  }
  const signer = getPolkadotSigner(account.publicKey, "Sr25519", async (input) =>
    account.sign(input),
  );
  console.log(`[deploy-counter] Deploying from ${account.address} (${source})…`);

  const counterExisting = await findCounterContract(api);
  const counterAddr = await deployIfMissing({
    label: "Counter",
    api,
    signer,
    bytecodeHex: COUNTER_BYTECODE_HEX,
    codeHash: COUNTER_CODE_HASH,
    existing: counterExisting,
  });
  void counterAddr;

  const popExisting = await findPopCounterContract(api);
  const popAddr = await deployIfMissing({
    label: "PopCounter",
    api,
    signer,
    bytecodeHex: POP_COUNTER_BYTECODE_HEX,
    codeHash: POP_COUNTER_CODE_HASH,
    existing: popExisting,
  });
  void popAddr;

  client.destroy();
}

main().catch((e) => {
  console.error("[deploy-counter] FAILED:", e);
  process.exit(1);
});
