/** Generator-only helpers. These do not change claim selection or runtime calls. */
import { closeSync, openSync, writeSync } from 'node:fs';
import { Blake2256, decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { createV4Tx } from '@polkadot-api/signers-common';
import { mergeUint8 } from '@polkadot-api/utils';
import { getPolkadotSigner } from 'polkadot-api/signer';

// The stock raw signer decodes identical metadata for every signature. Retain the
// decoded object across actors; calls and extension values still come from PAPI.
const metadataCache = new WeakMap<Uint8Array, ReturnType<typeof unifyMetadata>>();
export function capacitySigner(publicKey: Uint8Array, sign: (data: Uint8Array) => Uint8Array) {
  const base = getPolkadotSigner(publicKey, 'Sr25519', sign);
  const signTx: typeof base.signTx = async (call, extensions, metadata, _at, hasher = Blake2256) => {
    let decoded = metadataCache.get(metadata);
    if (!decoded) {
      decoded = unifyMetadata(decAnyMetadata(metadata));
      metadataCache.set(metadata, decoded);
    }
    const extra: Uint8Array[] = [], additional: Uint8Array[] = [];
    for (const { identifier } of decoded.extrinsic.signedExtensions[0]) {
      const extension = extensions[identifier];
      if (!extension) throw new Error(`Missing ${identifier} signed extension`);
      extra.push(extension.value);
      additional.push(extension.additionalSigned);
    }
    const payload = mergeUint8([call, ...extra, ...additional]);
    return createV4Tx(decoded, publicKey, sign(payload.length > 256 ? hasher(payload) : payload), extra, call, 'Sr25519');
  };
  return { ...base, signTx };
}

/** Preserve normal JSON artifacts without allocating a single giant JSON string. */
export function writeCapacityJson(path: string, value: unknown) {
  const fd = openSync(path, 'w');
  const stringify = (data: unknown) => JSON.stringify(data, (_, v) => typeof v === 'bigint' ? String(v) : v);
  const emit = (data: unknown): void => {
    if (Array.isArray(data)) {
      writeSync(fd, '[');
      for (let offset = 0; offset < data.length; offset += 1000) {
        if (offset) writeSync(fd, ',');
        writeSync(fd, stringify(data.slice(offset, offset + 1000)).slice(1, -1));
      }
      writeSync(fd, ']');
    } else if (data !== null && typeof data === 'object') {
      writeSync(fd, '{');
      let first = true;
      for (const [key, entry] of Object.entries(data)) {
        if (entry === undefined) continue;
        if (!first) writeSync(fd, ',');
        first = false;
        writeSync(fd, JSON.stringify(key) + ':');
        emit(entry);
      }
      writeSync(fd, '}');
    } else writeSync(fd, stringify(data));
  };
  try { emit(value); writeSync(fd, '\n'); } finally { closeSync(fd); }
}
