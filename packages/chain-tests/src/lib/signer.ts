import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getPolkadotSigner, type PolkadotSigner } from "polkadot-api/signer";
import { getNetworkConfig } from "../config/networks.js";

let ready = false;

export interface TestAccount {
  signer: PolkadotSigner;
  address: string;
}

function requireMnemonic(): string {
  const mnemonic = process.env.TEST_MNEMONIC;
  if (!mnemonic) {
    throw new Error(
      "TEST_MNEMONIC env var is required. See .env.example",
    );
  }
  return mnemonic;
}

async function ensureReady(): Promise<void> {
  if (!ready) {
    await cryptoWaitReady();
    ready = true;
  }
}

function buildSigner(account: ReturnType<Keyring["addFromMnemonic"]>): TestAccount {
  const signer = getPolkadotSigner(
    account.publicKey,
    "Sr25519",
    async (input) => account.sign(input),
  );
  return { signer, address: account.address };
}

/**
 * Funded test account. If the network config sets `testAccountUri`
 * (e.g. `//Alice` on dev testnets), uses that; otherwise falls back to
 * `TEST_MNEMONIC` env.
 */
export async function createTestAccount(): Promise<TestAccount> {
  await ensureReady();
  const keyring = new Keyring({ type: "sr25519" });
  const uri = getNetworkConfig().testAccountUri;
  const account = uri
    ? keyring.addFromUri(uri)
    : keyring.addFromMnemonic(requireMnemonic());
  return buildSigner(account);
}

