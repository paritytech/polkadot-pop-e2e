/** Free-token unload proofs. Secrets stay in memory, outside saved evidence. */
import assert from 'node:assert/strict';
import { compact, decAnyMetadata, extrinsicFormat, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { mergeUint8 } from 'polkadot-api/utils';
import { blake2b256 } from '@polkadot-labs/hdkd-helpers';
import type { PolkadotSigner } from 'polkadot-api';
import { alias_in_context, one_shot, type RingExponent } from 'verifiablejs/nodejs';

export const recyclerContext = new TextEncoder().encode('pop:polkadot.network/coinrecyclr');
export function u32(value: number) {
  assert(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
  const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out;
}
export function tokenContext(period: number, counter: number) {
  return mergeUint8([new TextEncoder().encode('pop:polkadot.net/coinftk'), u32(period), u32(counter)]);
}
export const voucherAlias = (entropy: Uint8Array) => alias_in_context(entropy, recyclerContext);
const bytes = (value: Uint8Array) => mergeUint8([compact.enc(value.length), value]);
export interface ProofRing { entropy: Uint8Array; members: Uint8Array; exponent: RingExponent; ring: number; revision: number }
export function unloadSigner(input: {
  person: ProofRing; vouchers: ProofRing[]; period: number; counter: number;
  observe?: (value: { kind: string; durationMs: number }) => void;
}): PolkadotSigner {
  assert(input.vouchers.length > 0);
  return {
    publicKey: new Uint8Array(32),
    signBytes() { throw new Error('Unload uses proofs, not an account signature'); },
    async signTx(callData, signedExtensions, metadata) {
      const ext = unifyMetadata(decAnyMetadata(metadata)).extrinsic.signedExtensions[0];
      const index = ext.findIndex(e => e.identifier === 'AsCoinage');
      assert(index >= 0, 'AsCoinage missing from runtime');
      const resolved = ext.map(e => { const value = signedExtensions[e.identifier]; assert(value, `Missing ${e.identifier}`); return { ...value }; });
      const trailing = resolved.slice(index + 1);
      const implication = mergeUint8([Uint8Array.of(0), callData,
        ...trailing.map(e => e.value), ...trailing.map(e => e.additionalSigned)]);
      const proofFor = (ring: ProofRing, context: Uint8Array, message: Uint8Array, kind: string) => {
        const start = performance.now();
        const result = one_shot(ring.exponent, ring.entropy, ring.members, context, message);
        input.observe?.({ kind, durationMs: performance.now() - start });
        return result.proof;
      };
      const aliases = mergeUint8([compact.enc(input.vouchers.length), ...input.vouchers.map(v =>
        bytes(proofFor(v, recyclerContext, blake2b256(implication), 'recycler')))]);
      const proof = proofFor(input.person, tokenContext(input.period, input.counter),
        blake2b256(mergeUint8([aliases, implication])), 'person-token');
      // Option::Some, AsUnloadTokenPeople (variant 1), MembershipProof, period, counter, aliases.
      resolved[index].value = mergeUint8([Uint8Array.of(1, 1), bytes(proof),
        u32(input.person.ring), u32(input.person.revision), u32(input.period), u32(input.counter), aliases]);
      const body = mergeUint8([extrinsicFormat.enc({ version: 5, type: 'general' }), Uint8Array.of(0),
        ...resolved.map(e => e.value), callData]);
      return mergeUint8([compact.enc(body.length), body]);
    },
  };
}
