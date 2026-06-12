/**
 * Definitions for the PoP-gated counter contract used by
 * `tests/pop-gate.test.ts`. Source: `contracts/PopCounter.sol`,
 * compiled via `scripts/compile-pop-counter.ts` into
 * `pop-counter-bytecode.ts`. Layout mirrors `counter-contract.ts`.
 *
 * The contract gates `bump()` on `IPersonhood.personhoodStatus(msg.sender, CTX)`
 * where CTX is the compile-time constant `bytes32("triangle-e2e:pop-counter")`.
 * Accounts without a matching alias mapping in
 * `AliasAccounts.AliasToAccount` revert with `NotPerson()`.
 */
import type { SizedHex } from "polkadot-api";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { AssetHubApi, RichAssetHubApi } from "./client.js";
import {
  POP_COUNTER_BYTECODE_HEX,
  POP_COUNTER_RUNTIME_HEX,
} from "./pop-counter-bytecode.js";

export { POP_COUNTER_BYTECODE_HEX, POP_COUNTER_RUNTIME_HEX };

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

function toHex(b: Uint8Array): string {
  return (
    "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")
  );
}

export const POP_COUNTER_BYTECODE = hexToBytes(POP_COUNTER_BYTECODE_HEX);
export const POP_COUNTER_RUNTIME = hexToBytes(POP_COUNTER_RUNTIME_HEX);
/** 32-byte keccak256(runtime) — the chain's contract index key. */
export const POP_COUNTER_CODE_HASH: Uint8Array = keccak_256(POP_COUNTER_RUNTIME);

/** Selector for `bump()` = keccak256("bump()")[0..4]. */
export const BUMP_SELECTOR_HEX: string =
  "0x" +
  Array.from(keccak_256(new TextEncoder().encode("bump()")).slice(0, 4))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

export async function findPopCounterContract(
  assetHubApi: AssetHubApi | RichAssetHubApi,
): Promise<SizedHex<20> | null> {
  const wantHex = toHex(POP_COUNTER_CODE_HASH);
  const entries = await assetHubApi.query.Revive.AccountInfoOf.getEntries();
  for (const e of entries) {
    const t = e.value?.account_type;
    if (t?.type !== "Contract") continue;
    if (t.value.code_hash !== wantHex) continue;
    return e.keyArgs[0];
  }
  return null;
}
