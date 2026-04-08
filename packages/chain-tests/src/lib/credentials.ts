/**
 * Read the attested account credentials written by globalSetup.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CREDENTIALS_PATH = resolve(import.meta.dirname, "../../.test-credentials.json");

export interface AttestedCredentials {
  attested: true;
  address: string;
  publicKey: Uint8Array;
  statementStoreSecret: Uint8Array;
  entropy: Uint8Array;
  username: string;
}

interface NoCredentials {
  attested: false;
}

export type Credentials = AttestedCredentials | NoCredentials;

export function loadCredentials(): Credentials {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  if (!raw.attested) return { attested: false };

  return {
    attested: true,
    address: raw.address,
    publicKey: Uint8Array.from(raw.publicKey),
    statementStoreSecret: Uint8Array.from(raw.statementStoreSecret),
    entropy: Uint8Array.from(raw.entropy),
    username: raw.username,
  };
}
