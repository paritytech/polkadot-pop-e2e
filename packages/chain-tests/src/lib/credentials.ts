/**
 * Shape of the attested-account credentials that `ensureAttested()`
 * (in `attested-fixture.ts`) produces and caches to
 * `.test-credentials.json`. Importable as a type-only dependency by
 * helpers that build signers / accounts from a registered lite-person.
 */

export interface AttestedCredentials {
  attested: true;
  /** Root mnemonic; truapi-host derives the person's keys from it. */
  mnemonic: string;
  /** dotNS TLD the person's keys are derived under. */
  networkSuffix: string;
  /** The person's `uid.<suffix>` identity account. */
  address: string;
  publicKey: Uint8Array;
  entropy: Uint8Array;
  username: string;
}

interface NoCredentials {
  attested: false;
}

export type Credentials = AttestedCredentials | NoCredentials;
