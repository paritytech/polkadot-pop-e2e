import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getTxCreator } from "polkadot-api/tx-creator";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { getNetworkConfig } from "../config/networks.js";

let ready = false;

export interface TestAccount {
  signer: CommonSignerTxCreator;
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

function buildSigner(account: KeyringPair): TestAccount {
  const signer = getTxCreator(
    account.publicKey,
    "Sr25519",
    async (input) => account.sign(input),
  );
  return { signer, address: account.address };
}

/**
 * Funded test account. If the network config sets `testAccountUri`
 * (`//Alice` on local forks), uses that; otherwise falls back to
 * `TEST_MNEMONIC` env. A `derivationPath` such as `//proxy` returns that
 * child of the test account instead, which the test funds itself.
 */
export async function createTestAccount(derivationPath = ""): Promise<TestAccount> {
  await ensureReady();
  const keyring = new Keyring({ type: "sr25519" });
  const uri = getNetworkConfig().testAccountUri ?? requireMnemonic();
  return buildSigner(keyring.addFromUri(`${uri}${derivationPath}`));
}

