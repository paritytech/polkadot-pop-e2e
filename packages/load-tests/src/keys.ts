import { p256 } from "@noble/curves/nist.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  blake2b256,
  entropyToMiniSecret,
  entropyToMnemonic,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import { deriveProductAccount, deriveProductSecret } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";

export interface Keypair {
  publicKey: Uint8Array;
  address: string;
  sign(message: Uint8Array): Uint8Array;
}

/** A load-test player: index `index` of the accounts derived from one run seed. */
export interface Player extends Keypair {
  index: number;
  /** The 64-byte sr25519 secret key, which a worker thread rebuilds the player from. */
  secretKey: Uint8Array;
  /** A lite bot's ring-VRF entropy, whose lite person signs this account up for free. */
  liteEntropy?: Uint8Array;
}

/** Player `index` with sr25519 secret key `secretKey`. */
export function playerFromSecret(index: number, secretKey: Uint8Array): Player {
  const publicKey = getPublicKey(secretKey);
  return { index, secretKey, publicKey, address: ss58Address(publicKey), sign: (message) => sign(secretKey, message) };
}

/** The same `seed` and `index` always derive the same account, in every shard and process. */
export function derivePlayer(seed: string, index: number): Player {
  return playerFromSecret(index, secretFromSeed(blake2b256(new TextEncoder().encode(`${seed}/${index}`))));
}

export function derivePlayers(seed: string, indices: Iterable<number>): Player[] {
  return Array.from(indices, (index) => derivePlayer(seed, index));
}

/** Host process `host`'s wallet: one per truapi-host, whose ghosts are its product accounts. */
export function hostMnemonic(seed: string, host: number): string {
  return entropyToMnemonic(blake2b256(new TextEncoder().encode(`${seed}/host/${host}`)).slice(0, 16));
}

/** Each host's `//product//<id>` secret, by `seed/productId/host`: deriving it costs a PBKDF2 and two hard junctions. */
const hostProductSecrets = new Map<string, Uint8Array>();

/**
 * Ghost `index` of a host layer run: product account `index % ghostsPerHost` of `productId` in
 * host `index / ghostsPerHost`, the account that host signs the ghost's statements with.
 */
export function hostGhostPlayer(seed: string, productId: string, ghostsPerHost: number, index: number): Player {
  const host = Math.floor(index / ghostsPerHost);
  const cacheKey = `${seed}/${productId}/${host}`;
  let secret = hostProductSecrets.get(cacheKey);
  if (!secret) {
    secret = deriveProductSecret(mnemonicToEntropy(hostMnemonic(seed, host)), productId);
    hostProductSecrets.set(cacheKey, secret);
  }
  return playerFromSecret(index, deriveProductAccount(secret, index % ghostsPerHost).secretKey);
}

/** An sr25519 key from a secret URI: `//Alice` (dev phrase) or `<mnemonic>[//path]`. */
export function keypairFromUri(uri: string): Keypair {
  const pathStart = uri.indexOf("/");
  const phrase = (pathStart < 0 ? uri : uri.slice(0, pathStart)).trim() || DEV_PHRASE;
  const path = pathStart < 0 ? "" : uri.slice(pathStart);
  const pair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase)))(path);
  return { publicKey: pair.publicKey, address: ss58Address(pair.publicKey), sign: (message) => pair.sign(message) };
}

/** The P-256 secret of a player's communication identifier, from its account, so a bot derives
 *  every co-player's identifier instead of reading it from the chain. */
export function communicationSecret(publicKey: Uint8Array): Uint8Array {
  return p256.utils.randomSecretKey(blake2b(publicKey, { dkLen: p256.lengths.seed }));
}

/** The 65-byte identifier a player signs up with: the public key of its `communicationSecret`. */
export function communicationIdentifier(publicKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(communicationSecret(publicKey), false);
}
