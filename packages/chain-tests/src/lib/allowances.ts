/**
 * Context builder for the long-term storage claim (paritytech/individuality
 * #893) on runtimes without product contexts, plus its period helper. The
 * statement-store and PGAS claims go through truapi-host instead.
 */

// ── Context builders ───────────────────────────────────────────────────────

const LONG_TERM_STORAGE_PREFIX = new TextEncoder().encode(
  "pop:polkadot.net/rsc-lts",
); // 24 bytes

function u32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
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

