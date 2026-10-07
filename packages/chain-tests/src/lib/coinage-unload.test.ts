import assert from 'node:assert/strict';
import { RingProofPool } from './coinage-proof-pool.js';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { compact, decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { mergeUint8 } from 'polkadot-api/utils';
import { blake2b256 } from '@polkadot-labs/hdkd-helpers';
import { previewPeople } from '@pop-e2e/papi';
import { member_from_entropy, is_valid } from 'verifiablejs/nodejs';
import { encodeMembers } from './ring.js';
import { unloadSigner, tokenContext, recyclerContext, voucherAlias } from './coinage-unload.js';

for (const workerCount of [0, 2]) test(`free unload binds recycler and token proofs (workers=${workerCount})`, async t => {
  const pool = workerCount ? new RingProofPool(workerCount) : undefined;
  t.after(async () => { await pool?.close(); });
  const metadata = await previewPeople.getMetadata(); assert(metadata);
  const extensions = unifyMetadata(decAnyMetadata(metadata)).extrinsic.signedExtensions[0];
  const signed = Object.fromEntries(extensions.map(({identifier}, i) => [identifier,
    { identifier, value: Uint8Array.of(i), additionalSigned: Uint8Array.of(i + 50) }]));
  const personEntropy = randomBytes(32), voucherEntropy = randomBytes(32);
  const person = { entropy: personEntropy, members: encodeMembers([member_from_entropy(personEntropy)]), exponent: 9 as const, ring: 0, revision: 1 };
  const voucher = { entropy: voucherEntropy, members: encodeMembers([member_from_entropy(voucherEntropy)]), exponent: 10 as const, ring: 0, revision: 1 };
  const call = Uint8Array.of(12, 4, 1, 2, 3);
  const output = await unloadSigner({ prove: pool?.prove, person, vouchers: [voucher], period: 123, counter: 5 }).signTx(call, signed, metadata, 0);
  // Decode the general extrinsic envelope and this extension's wire fields independently.
  const bodyLength = compact.dec(output); let offset = compact.enc(bodyLength).length;
  assert.equal(output[offset++], 0x45); assert.equal(output[offset++], 0);
  const index = extensions.findIndex(e => e.identifier === 'AsCoinage');
  for (const e of extensions.slice(0, index)) offset += signed[e.identifier].value.length;
  assert.equal(output[offset++], 1); assert.equal(output[offset++], 1);
  function proof() { const n = compact.dec(output.slice(offset)); offset += compact.enc(n).length; const p = output.slice(offset, offset + n); offset += n; return p; }
  const tokenProof = proof(); offset += 8;
  assert.equal(new DataView(output.buffer, output.byteOffset + offset).getUint32(0, true), 123); offset += 4;
  assert.equal(new DataView(output.buffer, output.byteOffset + offset).getUint32(0, true), 5); offset += 4;
  const aliasesStart = offset; assert.equal(output[offset++], 4); const recyclerProof = proof();
  const aliases = output.slice(aliasesStart, offset);
  const trailing = extensions.slice(index + 1).map(e => signed[e.identifier]);
  const implication = mergeUint8([Uint8Array.of(0), call, ...trailing.map(e => e.value), ...trailing.map(e => e.additionalSigned)]);
  const { alias_in_context } = await import('verifiablejs/nodejs');
  assert(is_valid(10, recyclerProof, voucher.members, recyclerContext, voucherAlias(voucherEntropy), blake2b256(implication)));
  assert(is_valid(9, tokenProof, person.members, tokenContext(123, 5), alias_in_context(personEntropy, tokenContext(123, 5)), blake2b256(mergeUint8([aliases, implication]))));
  const tampered = implication.slice(); tampered[2] ^= 1;
  assert(!is_valid(10, recyclerProof, voucher.members, recyclerContext, voucherAlias(voucherEntropy), blake2b256(tampered)));
});

test('proof workers preserve bindings with more jobs than workers', async t => {
  const pool = new RingProofPool(2);
  t.after(() => pool.close());
  const { alias_in_context } = await import('verifiablejs/nodejs');
  const entropy = randomBytes(32), members = encodeMembers([member_from_entropy(entropy)]);
  const inputs = Array.from({ length: 5 }, (_, i) => ({ exponent: 9 as const, entropy, members,
    context: tokenContext(123, i), message: blake2b256(Uint8Array.of(i)) }));
  const outputs = await Promise.all(inputs.map(pool.prove));
  for (const [i, output] of outputs.entries()) {
    const input = inputs[i];
    assert(is_valid(9, output.proof, members, input.context, alias_in_context(entropy, input.context), input.message));
    assert(!is_valid(9, output.proof, members, input.context, alias_in_context(entropy, input.context), inputs[(i + 1) % inputs.length].message));
    assert(output.elapsedMs >= output.computationMs);
  }
  await pool.close();
  await assert.rejects(pool.prove(inputs[0]), /closed/);
});
