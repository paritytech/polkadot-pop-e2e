import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createCoinageClient } from "../src/lib/coinage-client.js";

const help = `Usage: pnpm exec tsx scripts/coinage-client.ts <inspect|top-up> <instance-id> [denomination=1]

COINAGE_RPC          Local People WebSocket endpoint (default ws://127.0.0.1:10010).
COINAGE_SIGNER_URI   Funded account's secret URI, required for top-up.
COINAGE_VOUCHER_SEED Independent 32-byte voucher secret as 0x-prefixed hex, required for top-up.

This command uses an existing instance and funded account. It does not provision
the network, retry transactions, select coins, or wait for recycler ring readiness.`;

async function main() {
  const [operation, rawInstance, rawDenomination = "1"] = process.argv.slice(2);
  if (operation === "--help") { console.log(help); return; }
  if (!["inspect", "top-up"].includes(operation) || rawInstance === undefined) throw new Error(help);
  const instanceId = Number(rawInstance);
  if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId > 0xffff_ffff) {
    throw new Error("instance-id must be a u32");
  }
  const endpoint = process.env.COINAGE_RPC ?? "ws://127.0.0.1:10010";
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("This test command only connects to a local fork");
  }
  const signerUri = process.env.COINAGE_SIGNER_URI;
  const voucherSeed = process.env.COINAGE_VOUCHER_SEED;
  if (operation === "top-up" && (!signerUri || !/^0x[0-9a-fA-F]{64}$/.test(voucherSeed ?? ""))) {
    throw new Error("top-up requires COINAGE_SIGNER_URI and a 32-byte COINAGE_VOUCHER_SEED");
  }
  await cryptoWaitReady();
  const coinage = createCoinageClient(endpoint);
  // Bound startup/RPC failures as well as the transaction watch below.
  const deadline = setTimeout(() => {
    console.error("Coinage command exceeded its 11-minute deadline; outcome may be unresolved");
    coinage.close();
    process.exit(1);
  }, 660_000);
  const print = (value: unknown) => console.log(JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item, 2));
  try {
    if (operation === "inspect") {
      const { hash: at } = await coinage.client.getFinalizedBlock();
      const [instance, runtime, min, max] = await Promise.all([
        coinage.api.query.Coinage.Instances.getValue(instanceId, { at }),
        coinage.api.constants.System.Version(),
        coinage.api.constants.Coinage.MinimumExponent(),
        coinage.api.constants.Coinage.MaximumExponent(),
      ]);
      if (!instance) throw new Error(`Coinage instance ${instanceId} does not exist`);
      print({ endpoint, at, runtime, instanceId, instance, minimumExponent: min, maximumExponent: max });
      return;
    }
    const account = new Keyring({ type: "sr25519" }).addFromUri(signerUri!);
    const signer = getPolkadotSigner(account.publicKey, "Sr25519", (bytes) => account.sign(bytes));
    const prepared = await coinage.prepareTopUp({ instanceId, denomination: Number(rawDenomination), signer,
      voucherEntropy: Uint8Array.from(Buffer.from(voucherSeed!.slice(2), "hex")) });
    // Do not log account/voucher secrets or raw signed transaction bytes.
    const { signed: _, ...description } = prepared;
    print({ phase: "prepared", ...description });
    const result = await coinage.submitTopUp(prepared);
    print({ phase: "submitted", ...result });
    if (result.status !== "finalized") process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    coinage.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
