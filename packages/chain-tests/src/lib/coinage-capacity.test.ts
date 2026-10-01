import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { previewPeople } from '@pop-e2e/papi';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { capacitySigner, writeCapacityJson } from './coinage-capacity.js';

test('cached signer matches stock signer payload and extrinsic bytes, including long payload hashing', async () => {
  const metadata = await previewPeople.getMetadata();
  assert(metadata);
  const decoded = unifyMetadata(decAnyMetadata(metadata));
  const extensions = Object.fromEntries(decoded.extrinsic.signedExtensions[0].map(({ identifier }, i) =>
    [identifier, { identifier, value: Uint8Array.of(i), additionalSigned: Uint8Array.of(i + 1) }]));
  const publicKey = new Uint8Array(32).fill(42);
  const signature = new Uint8Array(64).fill(17);
  let stockPayload: Uint8Array | undefined, cachedPayload: Uint8Array | undefined;
  const stock = getPolkadotSigner(publicKey, 'Sr25519', bytes => { stockPayload = bytes; return signature; });
  const cached = capacitySigner(publicKey, bytes => { cachedPayload = bytes; return signature; });
  for (const length of [34, 1024, 34]) {
    const call = new Uint8Array(length).fill(12);
    assert.deepEqual(await cached.signTx(call, extensions, metadata, 100),
      await stock.signTx(call, extensions, metadata, 100));
    assert.deepEqual(cachedPayload, stockPayload);
  }
  await assert.rejects(cached.signTx(new Uint8Array(), {}, metadata, 100), /Missing/);
});

test('chunked evidence round-trips arrays, nested state, bigint and omitted properties', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinage-evidence-'));
  try {
    const value = { actors: Array.from({ length: 2501 }, (_, id) => ({ id, amount: BigInt(id), events: [] })),
      missing: undefined, empty: [], nested: { null: null, text: 'quote" newline\n' } };
    const file = join(dir, 'state.json');
    writeCapacityJson(file, value);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')),
      JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
