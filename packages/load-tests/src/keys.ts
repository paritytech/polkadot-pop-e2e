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
import { productAccountKey } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";

export interface Keypair {
  publicKey: Uint8Array;
  address: string;
  sign(message: Uint8Array): Uint8Array;
}

/** A load-test player: index `index` of the accounts derived from one run seed. */
export interface Player extends Keypair {
  index: number;
}

/** The same `seed` and `index` always derive the same account, in every shard and process. */
export function derivePlayer(seed: string, index: number): Player {
  const secret = secretFromSeed(blake2b256(new TextEncoder().encode(`${seed}/${index}`)));
  const publicKey = getPublicKey(secret);
  return { index, publicKey, address: ss58Address(publicKey), sign: (message) => sign(secret, message) };
}

export function derivePlayers(seed: string, indices: Iterable<number>): Player[] {
  return Array.from(indices, (index) => derivePlayer(seed, index));
}

/** Host process `host`'s wallet: one per truapi-host, whose ghosts are its product accounts. */
export function hostMnemonic(seed: string, host: number): string {
  return entropyToMnemonic(blake2b256(new TextEncoder().encode(`${seed}/host/${host}`)).slice(0, 16));
}

/**
 * Ghost `index` of a host layer run: product account `index % ghostsPerHost` of `productId` in
 * host `index / ghostsPerHost`, the account that host signs the ghost's statements with.
 */
export function hostGhostPlayer(seed: string, productId: string, ghostsPerHost: number, index: number): Player {
  const host = Math.floor(index / ghostsPerHost);
  const key = productAccountKey(mnemonicToEntropy(hostMnemonic(seed, host)), productId, index % ghostsPerHost);
  return { index, publicKey: key.publicKey, address: key.address, sign: key.sign };
}

/** An sr25519 key from a secret URI: `//Alice` (dev phrase) or `<mnemonic>[//path]`. */
export function keypairFromUri(uri: string): Keypair {
  const pathStart = uri.indexOf("/");
  const phrase = (pathStart < 0 ? uri : uri.slice(0, pathStart)).trim() || DEV_PHRASE;
  const path = pathStart < 0 ? "" : uri.slice(pathStart);
  const pair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase)))(path);
  return { publicKey: pair.publicKey, address: ss58Address(pair.publicKey), sign: (message) => pair.sign(message) };
}
