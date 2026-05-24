/**
 * Shape of the attested-account credentials that `ensureAttested()`
 * (in `attested-fixture.ts`) produces and caches to
 * `.test-credentials.json`. Importable as a type-only dependency by
 * helpers that build signers / accounts from a registered lite-person.
 */

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
