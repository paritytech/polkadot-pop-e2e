/**
 * Idempotent deployer for the PGAS test's counter contract on Asset Hub.
 *
 * Behaviour:
 *   1. Compute the EVM code_hash from `COUNTER_BYTECODE`.
 *   2. Search `Revive.AccountInfoOf` for any contract with that code_hash.
 *      - If found → log address, exit 0.
 *   3. Otherwise check `Revive.PristineCode[codeHash]`.
 *      - If uploaded → call `Revive.instantiate` (cheaper).
 *      - If not    → call `Revive.instantiate_with_code` (uploads + creates).
 *   4. Sign with `network.testAccountUri` (e.g. `//Alice` on previewnet) or
 *      `TEST_MNEMONIC` env. The deployer must have native funds on Asset
 *      Hub — PGAS pays for the *call*, not the deploy.
 *
 * Run before tests:
 *   NETWORK=previewnet pnpm deploy-counter
 */
import { createClient, Binary, type SizedHex } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getNetworkConfig } from "../src/config/networks.js";
import { descriptorsForNetwork } from "../src/lib/client.js";
import {
  COUNTER_BYTECODE_HEX,
  COUNTER_CODE_HASH,
  findCounterContract,
  toHex,
} from "../src/lib/counter-contract.js";

async function main() {
  await cryptoWaitReady();
  const network = getNetworkConfig();
  console.log(`[deploy-counter] Network: ${network.name}`);
  console.log(`[deploy-counter] code_hash: ${toHex(COUNTER_CODE_HASH)}`);

  const client = createClient(getWsProvider(network.assetHub.ws));
  const api = client.getTypedApi(descriptorsForNetwork().assetHub);

  const existing = await findCounterContract(api);
  if (existing) {
    // PAPI 2.x: SizedHex<20> is already a `0x…` string.
    console.log(`[deploy-counter] Already deployed at ${existing} — skipping.`);
    client.destroy();
    return;
  }
  // PAPI 2.x: Revive.PristineCode key is SizedHex<32> — pass hex string.
  const codeHashHex = toHex(COUNTER_CODE_HASH) as SizedHex<32>;

  // Pick a funded deployer — same resolution as chain-tests' funded ops:
  //   1. `network.testAccountUri` (e.g. `//Alice` on previewnet)
  //   2. `TEST_MNEMONIC` env (CI secret)
  // Fail loudly if neither resolves, instead of submitting an unsigned tx
  // and confusing the chain with `Payment`.
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
      "[deploy-counter] No deployer key available. Set network.testAccountUri " +
        "or TEST_MNEMONIC.",
    );
  }
  const signer = getPolkadotSigner(account.publicKey, "Sr25519", async (input) =>
    account.sign(input),
  );
  console.log(`[deploy-counter] Deploying from ${account.address} (${source})…`);

  // Already-uploaded code? Cheaper to skip the upload step.
  const pristine = await api.query.Revive.PristineCode.getValue(codeHashHex);
  let result;
  if (pristine) {
    console.log("[deploy-counter] Code already uploaded — calling instantiate.");
    const tx = api.tx.Revive.instantiate({
      value: 0n,
      weight_limit: { ref_time: 5_000_000_000n, proof_size: 200_000n },
      storage_deposit_limit: 1_000_000_000_000n,
      code_hash: codeHashHex,
      data: Binary.fromHex("0x"),
      salt: undefined,
    });
    result = await tx.signAndSubmit(signer);
  } else {
    console.log("[deploy-counter] First-time upload + instantiate.");
    const tx = api.tx.Revive.instantiate_with_code({
      value: 0n,
      weight_limit: { ref_time: 5_000_000_000n, proof_size: 200_000n },
      storage_deposit_limit: 1_000_000_000_000n,
      code: Binary.fromHex("0x" + COUNTER_BYTECODE_HEX),
      data: Binary.fromHex("0x"),
      salt: undefined,
    });
    result = await tx.signAndSubmit(signer);
  }
  if (!result.ok) {
    throw new Error(
      `[deploy-counter] Deploy failed: dispatchError=${JSON.stringify(result.dispatchError)}`,
    );
  }
  // PAPI 2.x: `contract` arrives as `SizedHex<20>` — already a "0x…" string.
  const instantiated = result.events?.find(
    (e: { type: string; value: { type: string } }) =>
      e.type === "Revive" && e.value?.type === "Instantiated",
  ) as { value: { value: { contract: string } } } | undefined;
  if (!instantiated) {
    throw new Error("[deploy-counter] No Revive.Instantiated event in result");
  }
  const addr = instantiated.value.value.contract;
  console.log(`[deploy-counter] Deployed at ${addr} block=#${result.block.number}`);
  client.destroy();
}

main().catch((e) => {
  console.error("[deploy-counter] FAILED:", e);
  process.exit(1);
});
