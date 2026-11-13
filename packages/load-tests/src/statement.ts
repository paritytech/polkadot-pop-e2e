import { createExpiry, getStatementSigner, statementCodec, stringToTopic } from "@novasamatech/sdk-statement";
import { toHex } from "@polkadot-api/utils";
import type { Keypair } from "./keys.js";

export type Hex = `0x${string}`;

export const topicOf = (text: string): Hex => stringToTopic(text) as Hex;

/** Marks a load-test payload; receivers find the probe header by searching the statement hex for it. */
const MAGIC = new TextEncoder().encode("POPLOAD1");
const MAGIC_HEX = toHex(MAGIC).slice(2);
const HEADER_BYTES = MAGIC.length + 4 + 4 + 8;

export interface Probe {
  sender: number;
  sequence: number;
  sentAt: number;
}

/** `bytes` of payload starting with the probe header; the rest is filler. */
export function probePayload(probe: Probe, bytes: number): Uint8Array {
  const payload = new Uint8Array(Math.max(bytes, HEADER_BYTES));
  payload.set(MAGIC);
  const view = new DataView(payload.buffer, MAGIC.length);
  view.setUint32(0, probe.sender);
  view.setUint32(4, probe.sequence);
  view.setFloat64(8, probe.sentAt);
  return payload;
}

/** The probe a SCALE-encoded statement in hex carries; undefined for statements of others. */
export function readProbe(statementHex: string): Probe | undefined {
  let at = statementHex.indexOf(MAGIC_HEX);
  // A match at an odd offset straddles two bytes: the "0x" prefix puts byte boundaries at even ones.
  while (at >= 0 && at % 2 === 1) at = statementHex.indexOf(MAGIC_HEX, at + 1);
  if (at < 0) return undefined;
  const start = at + MAGIC_HEX.length;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(statementHex.slice(start + i * 2, start + i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  return { sender: view.getUint32(0), sequence: view.getUint32(4), sentAt: view.getFloat64(8) };
}

export interface StatementFields {
  topics: Hex[];
  channel: Hex;
  expirySeconds: number;
  /** Orders statements on one channel: a later one with the same expiry second replaces it. */
  sequence: number;
  data: Uint8Array;
}

/** The statement signed by `signer`, SCALE-encoded as `statement_submit` takes it. */
export async function signStatement(signer: Keypair, fields: StatementFields): Promise<Hex> {
  const statement = {
    expiry: createExpiry(fields.expirySeconds, fields.sequence),
    channel: fields.channel,
    topics: fields.topics,
    data: fields.data,
  };
  const signed = await getStatementSigner(signer.publicKey, "sr25519", signer.sign).sign(statement);
  return toHex(statementCodec.enc(signed)) as Hex;
}
