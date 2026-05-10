/**
 * Context builders for the anonymous allowance claim flows introduced by:
 *   - paritytech/individuality #830 (StatementStore allowance)
 *   - paritytech/individuality #893 (Bulletin long-term storage)
 *   - paritytech/individuality #839 (PGAS gas allowance, Asset Hub)
 *
 * Each flow binds a ring-VRF proof to a 32-byte `context` derived from
 * the period/day + slot/seq/counter the claim is being made for. This
 * file only exports the context builders + period helpers; the claim
 * submission lives in `lts-claim.ts` and the test files (PGAS/StmtStore).
 */
import { SECONDS_PER_DAY } from "./ring.js";

// ── Context builders ───────────────────────────────────────────────────────

const STMT_STORE_PREFIX = new TextEncoder().encode("SSS_SLOT:"); // 9 bytes
const PGAS_PREFIX = new TextEncoder().encode("pop:gas:"); // 8 bytes
const LONG_TERM_STORAGE_PREFIX = new TextEncoder().encode(
  "pop:polkadot.net/rsc-lts",
); // 24 bytes

function u32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}
function u32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** `b"SSS_SLOT:" || period (BE u32) || seq (BE u32)` padded to 32 bytes with `b' '`. */
export function stmtStoreContext(period: number, seq: number): Uint8Array {
  const out = new Uint8Array(32).fill(0x20); // b' '
  out.set(STMT_STORE_PREFIX, 0);
  out.set(u32BE(period), 9);
  out.set(u32BE(seq), 13);
  return out;
}

/** `b"pop:gas:" || day (LE u32) || slot_index (LE u32)` padded to 32 bytes with zeros. */
export function pgasContext(day: number, slotIndex: number): Uint8Array {
  const out = new Uint8Array(32);
  out.set(PGAS_PREFIX, 0);
  out.set(u32LE(day), 8);
  out.set(u32LE(slotIndex), 12);
  return out;
}

/** `b"pop:polkadot.net/rsc-lts" || period (BE u32) || counter (u8)` zero-padded to 32 bytes. */
export function longTermStorageContext(
  period: number,
  counter: number,
): Uint8Array {
  if (counter < 0 || counter > 255) {
    throw new Error(`counter must fit in u8, got ${counter}`);
  }
  const out = new Uint8Array(32);
  out.set(LONG_TERM_STORAGE_PREFIX, 0);
  out.set(u32BE(period), 24);
  out[28] = counter & 0xff;
  return out;
}

// ── Period helpers ─────────────────────────────────────────────────────────

/** Day index since Unix epoch (used by stmt-store and PGAS). */
export function dayFromTimestamp(nowSecs: number): number {
  return Math.floor(nowSecs / SECONDS_PER_DAY);
}

/**
 * Long-term-storage period from timestamp. Period duration is configured
 * on chain (`LongTermStoragePeriodDuration`, defaults to 2 weeks). Pass the
 * chain constant in seconds.
 */
export function longTermStoragePeriodFromTimestamp(
  nowSecs: number,
  periodDurationSecs: number,
): number {
  return Math.floor(nowSecs / periodDurationSecs);
}

