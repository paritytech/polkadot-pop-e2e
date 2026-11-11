import type { Transaction, TxCallData } from "polkadot-api";
import { mergeUint8 } from "@polkadot-api/utils";
import { getTxCreator } from "polkadot-api/tx-creator";
import { PEOPLE_CLAIM_EXTENSIONS } from "@pop-e2e/chain-tests/src/lib/people-claim.js";
import type { Keypair, Player } from "./keys.js";
import type { PeopleApi } from "./target.js";

type Included = { ok: boolean; events: Array<{ type: string; value: { type: string; value: unknown } }>; block: { number: number }; dispatchError?: unknown };

/** Signs `tx`, submits it and resolves once a best block includes it; fails if it doesn't execute. */
export function submitToBestBlock(tx: Transaction, signer: Keypair): Promise<Included> {
  return new Promise((resolve, reject) => {
    const creator = getTxCreator(signer.publicKey, "Sr25519", async (input) => signer.sign(input));
    const subscription = tx.createSubmitAndWatch(creator, { customSignedExtensions: PEOPLE_CLAIM_EXTENSIONS } as never).subscribe({
      next(event) {
        if (event.type !== "inBestBlock") return;
        subscription.unsubscribe();
        if (event.ok) resolve(event as unknown as Included);
        else reject(new Error(`extrinsic failed in #${event.block.number}: ${JSON.stringify(event.dispatchError)}`));
      },
      error: reject,
    });
  });
}

/**
 * Dispatches `calls` as root, `chunk` per `Utility.batch_all`, one batch per block. Fails on
 * the first batch whose dispatch fails.
 */
export async function dispatchAsRoot(
  api: PeopleApi,
  sudo: Keypair,
  calls: TxCallData[],
  chunk: number,
  label: string,
): Promise<void> {
  for (let start = 0; start < calls.length; start += chunk) {
    const batch = api.tx.Utility.batch_all({ calls: calls.slice(start, start + chunk) });
    const included = await submitToBestBlock(api.tx.Sudo.sudo({ call: batch.decodedCall }), sudo);
    const sudid = included.events.find((event) => event.type === "Sudo" && event.value.type === "Sudid");
    const result = (sudid?.value.value as { sudo_result?: { success: boolean; value: unknown } } | undefined)?.sudo_result;
    if (!result?.success) {
      throw new Error(`${label}: root dispatch failed in #${included.block.number}: ${JSON.stringify(result?.value ?? "no Sudid event")}`);
    }
    const done = Math.min(start + chunk, calls.length);
    console.log(`[${label}] ${done}/${calls.length} in #${included.block.number}`);
  }
}

const ALLOWANCE_PREFIX = new TextEncoder().encode(":statement_allowance:");

/** The storage key the node reads a player's statement allowance from. */
export function statementAllowanceKey(player: Player): Uint8Array {
  return mergeUint8([ALLOWANCE_PREFIX, player.publicKey]);
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export interface StatementAllowance {
  count: number;
  bytes: number;
}

/**
 * Writes each player's statement allowance into the node-read `:statement_allowance:` key, so
 * the players can submit statements without signing up to a game.
 */
export async function grantStatementAllowance(
  api: PeopleApi,
  sudo: Keypair,
  players: Player[],
  allowance: StatementAllowance,
): Promise<void> {
  const value = mergeUint8([u32le(allowance.count), u32le(allowance.bytes)]);
  const items = players.map((player) => [statementAllowanceKey(player), value] as [Uint8Array, Uint8Array]);
  const calls: TxCallData[] = [];
  for (let start = 0; start < items.length; start += 1000) {
    calls.push(api.tx.System.set_storage({ items: items.slice(start, start + 1000) }).decodedCall);
  }
  await dispatchAsRoot(api, sudo, calls, 1, "allowance");
}

/** Sets each player's free balance to `planck`. */
export async function fundPlayers(api: PeopleApi, sudo: Keypair, players: Player[], planck: bigint): Promise<void> {
  const calls = players.map(
    (player) => api.tx.Balances.force_set_balance({ who: { type: "Id", value: player.address }, new_free: planck }).decodedCall,
  );
  await dispatchAsRoot(api, sudo, calls, 1000, "fund");
}
