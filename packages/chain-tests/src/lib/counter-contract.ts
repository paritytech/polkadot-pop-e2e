/**
 * Shared definitions for the test counter contract used by
 * `scripts/deploy-counter.ts` (idempotent deployer) and
 * `tests/allowances.test.ts` (PGAS-paid call test).
 *
 * EVM bytecode (hand-rolled, 12-byte init + 20-byte runtime = 32 bytes):
 *   init:    PUSH1 0x14 PUSH1 0x0c PUSH1 0x00 CODECOPY
 *            PUSH1 0x14 PUSH1 0x00 RETURN
 *   runtime: PUSH1 0x42 PUSH1 0x00 MSTORE
 *            PUSH1 0x20 PUSH1 0x00 LOG0
 *            PUSH1 0x00 SLOAD PUSH1 0x01 ADD PUSH1 0x00 SSTORE STOP
 *
 * Each call emits LOG0 with `0x00…0042` and increments storage slot 0,
 * which bumps `Revive.AccountInfoOf[addr].storage_items` 0 → 1 the first
 * time and (under the hood) flips the deposit account on subsequent calls.
 *
 * NB: the chain stores `code_hash = keccak256(runtime)` — NOT
 * `keccak256(init || runtime)`. Get this wrong and the look-up misses.
 */
import type { SizedHex } from "polkadot-api";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { AssetHubApi, RichAssetHubApi } from "./client.js";

export const COUNTER_BYTECODE_HEX =
  "6014600c60003960146000f3604260005260206000a060005460010160005500";
export const COUNTER_RUNTIME_HEX = COUNTER_BYTECODE_HEX.slice(24);

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export const COUNTER_BYTECODE = hexToBytes(COUNTER_BYTECODE_HEX);
export const COUNTER_RUNTIME = hexToBytes(COUNTER_RUNTIME_HEX);
/** 32-byte keccak256(runtime) — the value the chain indexes contracts by. */
export const COUNTER_CODE_HASH: Uint8Array = keccak_256(COUNTER_RUNTIME);

export function toHex(b: Uint8Array): string {
  return (
    "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Walk `Revive.AccountInfoOf` looking for a contract whose stored
 * `code_hash` matches our counter runtime. Returns the 20-byte EVM
 * address as `0x…` hex (`SizedHex<20>` — what PAPI 2.x descriptors
 * expect for `Revive.call`'s `dest` argument), or `null` if no copy
 * is deployed.
 */
export async function findCounterContract(
  // Both LegacyAssetHubApi (paseo) and RichAssetHubApi (preview, paseo-next-v2)
  // expose `Revive.AccountInfoOf` — that's all this function touches.
  assetHubApi: AssetHubApi | RichAssetHubApi,
): Promise<SizedHex<20> | null> {
  const wantHex = toHex(COUNTER_CODE_HASH);
  const entries = await assetHubApi.query.Revive.AccountInfoOf.getEntries();
  for (const e of entries) {
    const t = e.value?.account_type;
    if (t?.type !== "Contract") continue;
    const onChain = t.value.code_hash;
    // code_hash is SizedHex<32> in 2.x — already a hex string.
    if (onChain !== wantHex) continue;
    return e.keyArgs[0];
  }
  return null;
}
