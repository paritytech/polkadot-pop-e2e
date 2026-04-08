import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicToEntropy } from "@polkadot/util-crypto";
import { getPolkadotSigner, type PolkadotSigner } from "polkadot-api/signer";
import { createSr25519Secret } from "@novasamatech/statement-store";

let ready = false;

export interface TestAccount {
  signer: PolkadotSigner;
  address: string;
}

export interface StatementStoreAccount {
  secret: Uint8Array;
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

/** Create the funded test account (from TEST_MNEMONIC env). Used for all operations except Bulletin authorization. */
export async function createTestAccount(): Promise<TestAccount> {
  await ensureReady();
  const mnemonic = requireMnemonic();
  const keyring = new Keyring({ type: "sr25519" });
  const account = keyring.addFromMnemonic(mnemonic);
  const signer = getPolkadotSigner(
    account.publicKey,
    "Sr25519",
    async (input) => account.sign(input),
  );
  return { signer, address: account.address };
}

/** Create the Bulletin authorizer account. Used for TransactionStorage.authorize_account. */
export async function createBulletinSigner(): Promise<TestAccount> {
  await ensureReady();
  const mnemonic = process.env.BULLETIN_MNEMONIC;
  if (!mnemonic) {
    throw new Error(
      "BULLETIN_MNEMONIC env var is required for Bulletin authorize_account",
    );
  }
  const keyring = new Keyring({ type: "sr25519" });
  const account = keyring.addFromMnemonic(mnemonic);
  const signer = getPolkadotSigner(
    account.publicKey,
    "Sr25519",
    async (input) => account.sign(input),
  );
  return { signer, address: account.address };
}

/** Create sr25519 secret for Statement Store prover (from TEST_MNEMONIC entropy). */
export function createStatementStoreSecret(): StatementStoreAccount {
  const mnemonic = requireMnemonic();
  const entropy = mnemonicToEntropy(mnemonic);
  const secret = createSr25519Secret(entropy);
  return { secret };
}
