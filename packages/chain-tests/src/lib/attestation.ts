/**
 * Generates attestation parameters and registers a fresh lite person
 * via the identity-backend API. Adapted from:
 * triangle-js-sdks/packages/host-papp/src/sso/auth/attestationService.ts
 */

import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  blake2b256,
  entropyToMiniSecret,
} from "@polkadot-labs/hdkd-helpers";
import { toHex, mergeUint8 } from "@polkadot-api/utils";
import { member_from_entropy, sign } from "verifiablejs/nodejs";
import { AccountId } from "polkadot-api";
import { createSr25519Secret, deriveSr25519PublicKey } from "@novasamatech/statement-store";

const MSG_PREFIX = new TextEncoder().encode("pop:people-lite:register using");
const accountId = AccountId();

function randomEntropy(): Uint8Array {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  return entropy;
}

function deriveKeyPair(entropy: Uint8Array) {
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  return derive("");
}

export interface AttestationCredentials {
  address: string;
  publicKey: Uint8Array;
  statementStoreSecret: Uint8Array;
  entropy: Uint8Array;
}

export interface RegisterParams {
  candidateAccountId: string;
  username: string;
  candidateSignature: string;
  ringVrfKey: string;
  proofOfOwnership: string;
  consumerRegistrationSignature: string;
  identifierKey: string;
}

/**
 * Generate a fresh random account with all attestation parameters.
 */
export function generateAttestationParams(): {
  credentials: AttestationCredentials;
  params: RegisterParams;
} {
  const entropy = randomEntropy();
  const keyPair = deriveKeyPair(entropy);
  const publicKey = keyPair.publicKey;
  const address = accountId.dec(publicKey);

  // Ring VRF key from entropy
  const verifiableEntropy = blake2b256(entropy);
  const ringVrfKey = member_from_entropy(verifiableEntropy);

  // Attestation message: MSG_PREFIX || publicKey || ringVrfKey
  const message = mergeUint8(MSG_PREFIX, publicKey, ringVrfKey);

  // Candidate signature (sr25519)
  const candidateSignature = keyPair.sign(message);

  // Ring VRF proof of ownership
  const proofOfOwnership = sign(verifiableEntropy, message);

  // Identifier key (65 bytes — ECDH public key format)
  const identifierKeyEntropy = blake2b256(new Uint8Array([...entropy, 0x01]));
  const identifierSecret = createSr25519Secret(identifierKeyEntropy);
  const identifierPub = deriveSr25519PublicKey(identifierSecret);
  const identifierKey = new Uint8Array(65);
  identifierKey[0] = 0x04;
  identifierKey.set(identifierPub.slice(0, 32), 1);
  identifierKey.set(identifierPub.slice(0, 32), 33);

  // Username must match /^([a-z]{6,})$/ — min 6 lowercase alpha chars
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  const username = `etest${suffix}`;

  const statementStoreSecret = createSr25519Secret(entropy);

  return {
    credentials: { address, publicKey, statementStoreSecret, entropy },
    params: {
      candidateAccountId: address,
      username,
      candidateSignature: toHex(candidateSignature),
      ringVrfKey: toHex(ringVrfKey),
      proofOfOwnership: toHex(proofOfOwnership),
      consumerRegistrationSignature: "", // filled by signAndRegister()
      identifierKey: toHex(identifierKey),
    },
  };
}

/**
 * Fetch the attester public key, sign consumer registration, then POST to register.
 */
export async function signAndRegister(
  backendUrl: string,
  entropy: Uint8Array,
  params: RegisterParams,
): Promise<{ username: string }> {
  // Fetch attester public key
  const attesterRes = await fetch(`${backendUrl}/api/v1/attester`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!attesterRes.ok) {
    throw new Error(`Identity backend attester endpoint failed: ${attesterRes.status}`);
  }
  const { attester } = (await attesterRes.json()) as { attester: string };
  const attesterBytes = hexToBytes(attester);

  // Rebuild keypair to sign consumer registration
  const keyPair = deriveKeyPair(entropy);
  const identifierKeyBytes = hexToBytes(params.identifierKey.slice(2));

  // Consumer registration signing payload (SCALE-encoded tuple):
  // (candidate_pubkey[32], verifier_accountid[32], identifierKey[65], username_base, Option::None)
  const usernameBase = params.username.split(".")[0] ?? params.username;
  const usernameBytes = new TextEncoder().encode(usernameBase);
  const usernameLenPrefix = new Uint8Array([usernameBytes.length * 4]); // SCALE compact

  const consumerPayload = mergeUint8(
    keyPair.publicKey,
    attesterBytes,
    identifierKeyBytes,
    usernameLenPrefix,
    usernameBytes,
    new Uint8Array([0]), // Option::None (reserved_username)
  );

  const consumerRegistrationSignature = keyPair.sign(consumerPayload);
  params.consumerRegistrationSignature = toHex(consumerRegistrationSignature);

  // POST to register
  const registerRes = await fetch(`${backendUrl}/api/v1/usernames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });

  if (!registerRes.ok) {
    const body = await registerRes.text();
    throw new Error(
      `Identity backend register failed (${registerRes.status}): ${body}`,
    );
  }

  const result = (await registerRes.json()) as {
    base_username: string;
    digits: string;
    username: string;
  };

  return { username: result.username };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
