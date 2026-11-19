/**
 * Fork-only helpers, shared by the fork-gated suites: the best-block read and poll pace, a fresh
 * sr25519 account, and a transfer that funds it from the fork's //Alice. A live network does not
 * give that key, so only the fork suites call these.
 */
import { randomBytes } from "node:crypto";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { AccountId, type SS58String } from "polkadot-api";
import { getTxCreator } from "polkadot-api/tx-creator";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import { formatDispatchError, submitAndWatch } from "@parity/product-sdk-tx";
import type { AssetHubApi, PeopleApi } from "./client.js";

/**
 * Fork reads are pinned to the best block: the finalized head trails it on these networks, which
 * would put a schedule's timing and a batch's state out of step.
 */
export const READ_AT = { at: "best" } as const;
/** A block, roughly: the pace the fork polls the chain at. */
export const POLL_MS = 6_000;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FUND_TIMEOUT_MS = 90_000;

export interface FreshAccount {
  address: SS58String;
  publicKey: Uint8Array;
  /** The 64-byte expanded key `secretFromSeed` returns, which `localAirdropVrfSigner` takes. */
  secret: Uint8Array;
  signer: CommonSignerTxCreator;
}

/** A fresh sr25519 account from a random seed. */
export function createFreshSr25519Account(): FreshAccount {
  const secret = secretFromSeed(randomBytes(32));
  const publicKey = getPublicKey(secret);
  return {
    address: AccountId().dec(publicKey),
    publicKey,
    secret,
    signer: getTxCreator(publicKey, "Sr25519", (message) => sign(secret, message)),
  };
}

/**
 * Moves `amount` from the funder to `address` with `Balances.transfer_keep_alive`, then polls the
 * best block until the balance shows it.
 */
export async function fundAccount(
  api: PeopleApi | AssetHubApi,
  funder: CommonSignerTxCreator,
  address: SS58String,
  amount: bigint,
): Promise<void> {
  const result = await submitAndWatch(
    api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: address }, value: amount }),
    funder,
    { waitFor: "best-block" },
  );
  if (!result.ok) throw result.error;
  if (!result.value.ok) {
    throw new Error(`funding ${address} failed: ${formatDispatchError(result.value)}`);
  }

  const deadline = Date.now() + FUND_TIMEOUT_MS;
  for (;;) {
    const { data } = await api.query.System.Account.getValue(address, READ_AT);
    if (data.free >= amount) return;
    if (Date.now() > deadline) {
      throw new Error(`${address} holds ${data.free} at the best block, short of ${amount}`);
    }
    await sleep(POLL_MS);
  }
}
