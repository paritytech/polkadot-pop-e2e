/**
 * The RFC-0022 keys truapi derives for a person from their root entropy
 * (`truapi::host_logic::product_account`). The truapi-host CLI attests the
 * identity account, so the tests must sign and prove with these keys too.
 * Pinned to truapi's own vectors in tests/unit/truapi-identity.test.ts.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { HDKD, getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { AccountId, compact } from "@polkadot-api/substrate-bindings";

const blake2b256 = (message: Uint8Array, key?: Uint8Array) =>
  blake2b(message, { dkLen: 32, ...(key ? { key } : {}) });

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A Substrate junction's 32-byte chain code: its SCALE string, padded or hashed. */
function chainCode(junction: string): Uint8Array {
  const bytes = new TextEncoder().encode(junction);
  const encoded = concat(compact.enc(bytes.length), bytes);
  if (encoded.length > 32) return blake2b256(encoded);
  const code = new Uint8Array(32);
  code.set(encoded);
  return code;
}

/** `index` little-endian, then `blake2b256("product-account-index")[..28]`. */
export function indexBytes(index: number): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, index, true);
  out.set(blake2b256(new TextEncoder().encode("product-account-index")).subarray(0, 28), 4);
  return out;
}

export interface IdentityKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
  sign: (message: Uint8Array) => Uint8Array;
}

/** `//product//uid.<suffix>` hard, then the soft `index_bytes(0)`: the person's identity account. */
export function identityKey(entropy: Uint8Array, networkSuffix: string): IdentityKey {
  let secret: Uint8Array = secretFromSeed(entropyToMiniSecret(entropy));
  for (const junction of ["product", `uid.${networkSuffix}`]) {
    secret = HDKD.secretHard(secret, chainCode(junction));
  }
  const secretKey = HDKD.secretSoft(secret, indexBytes(0));
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    publicKey,
    address: AccountId().dec(publicKey),
    sign: (message) => sign(secretKey, message),
  };
}

/** Ring-VRF entropy of the person's `index`th member key under `peopl.<suffix>`. */
function ringEntropyAt(entropy: Uint8Array, networkSuffix: string, index: number): Uint8Array {
  const root = blake2b256(entropy, new TextEncoder().encode("ring-vrf"));
  const domain = blake2b256(root, chainCode(`peopl.${networkSuffix}`));
  return blake2b256(domain, indexBytes(index));
}

/** The LitePeople ring member's VRF entropy. */
export const liteRingEntropy = (entropy: Uint8Array, networkSuffix: string) =>
  ringEntropyAt(entropy, networkSuffix, 1);

type PersonCreds = { entropy: Uint8Array; networkSuffix: string };

/** The attested person's identity account key. */
export const personKey = (creds: PersonCreds) => identityKey(creds.entropy, creds.networkSuffix);

/** The attested person's LitePeople ring-VRF entropy. */
export const personRingEntropy = (creds: PersonCreds) =>
  liteRingEntropy(creds.entropy, creds.networkSuffix);
