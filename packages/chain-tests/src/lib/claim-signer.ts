/**
 * Custom PolkadotSigner for ring-VRF allowance claims (paritytech/individuality
 * #830, #893, #839). Submits a v5 general transaction whose proof message
 * binds to the live `inherited_implication` (which depends on chain-state
 * implicits like mortality block hash, so it can only be computed inside the
 * signer). The signer:
 *
 *   1. Computes `inherited_implication = [extVer=0] || callData ||
 *      concat(trailing values) || concat(trailing implicits)`.
 *   2. Hashes it via blake2_256 to get the proof message.
 *   3. Generates the ring-VRF proof.
 *   4. Hand-encodes the proof-bearing extension value (Option<Enum<...>>)
 *      and replaces the placeholder `signedExtensions[name].value`.
 *   5. Builds the v5 general blob.
 *
 * Workaround tracked at https://github.com/polkadot-api/polkadot-api/issues/760.
 */
import { type PolkadotSigner } from "polkadot-api";
import {
  compact,
  decAnyMetadata,
  extrinsicFormat,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import { mergeUint8 } from "polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { verifiableFor } from "./verifiable-loader.js";

const EXTENSION_VERSION = 0;

export interface ClaimSignerOpts {
  /** Name of the extension carrying the proof — e.g. `"AsResources"` or `"AsPgas"`. */
  extensionName: string;
  /** 32-byte proof context (per allowance flow). */
  context: Uint8Array;
  /** verifiable_entropy = blake2_256(raw attestation entropy). */
  verifiableEntropy: Uint8Array;
  /** SCALE-encoded `Vec<MemberKey>` for the active ring (insertion-ordered). */
  encodedMembers: Uint8Array;
  /**
   * Build the SCALE-encoded extension value from the proof bytes. The chain
   * decodes this into `Option<ExtensionVariant>`; return the full encoded
   * blob (including the leading `0x01` Option::Some byte and any variant
   * tag).
   */
  encodeExtensionValue: (proof: Uint8Array) => Uint8Array;
}

export function createClaimSigner(opts: ClaimSignerOpts): PolkadotSigner {
  return {
    publicKey: new Uint8Array(32),
    signBytes() {
      throw new Error("claimSigner: signBytes is unsupported");
    },
    async signTx(callData, signedExtensions, metadata) {
      const decMeta = unifyMetadata(decAnyMetadata(metadata));
      const extList = decMeta.extrinsic.signedExtensions[EXTENSION_VERSION];

      const targetIdx = extList.findIndex(
        (e: { identifier: string }) => e.identifier === opts.extensionName,
      );
      if (targetIdx < 0) {
        throw new Error(
          `claimSigner: extension '${opts.extensionName}' not found in chain metadata`,
        );
      }

      // Resolve every extension's bytes (PAPI has filled in chain-state
      // implicits like mortality block hash, spec version, etc).
      const resolved = extList.map(({ identifier }: { identifier: string }) => {
        const ext = signedExtensions[identifier];
        if (!ext) {
          throw new Error(`claimSigner: missing signed extension '${identifier}'`);
        }
        return { identifier, value: ext.value, implicit: ext.additionalSigned };
      });

      // Build inherited_implication for the target extension. Following the
      // for_tuples loop in substrate's TransactionExtension impl for tuples,
      // the encoding flattens to:
      //   TxBaseImplication((extVer, call)) || trailing_explicit || trailing_implicit
      // where "trailing" = positions strictly after the target extension.
      const trailing = resolved.slice(targetIdx + 1);
      const trailingValues = mergeUint8(trailing.map((r) => r.value));
      const trailingImplicits = mergeUint8(trailing.map((r) => r.implicit));
      const inheritedImplication = mergeUint8([
        new Uint8Array([EXTENSION_VERSION]),
        callData,
        trailingValues,
        trailingImplicits,
      ]);
      const message = blake2b256(inheritedImplication);

      // Generate the ring-VRF proof bound to (context, message). The
      // verifiablejs build is network-aware — ThinVRF (v0.7.0+) vs
      // pre-ThinVRF (v0.6.5).
      const { one_shot } = verifiableFor();
      const result = one_shot(
        opts.verifiableEntropy,
        opts.encodedMembers,
        opts.context,
        message,
      );

      // Replace the target extension's value with our proof-bearing one.
      const proofValue = opts.encodeExtensionValue(result.proof);
      resolved[targetIdx].value = proofValue;

      // Assemble the v5 general blob.
      const preResult = mergeUint8([
        extrinsicFormat.enc({ version: 5, type: "general" }),
        new Uint8Array([EXTENSION_VERSION]),
        ...resolved.map((r) => r.value),
        callData,
      ]);
      return mergeUint8([compact.enc(preResult.length), preResult]);
    },
  };
}

/**
 * AsResources Option<Enum> variant tags (defined in pallet-resources):
 *   0: RegisterFriendRequestWithProof
 *   1: RegisterFriendRequestForCollection
 *   2: RegisterStatementStoreAllowance
 *   3: ClaimLongTermStorage
 *
 * MembershipCollection enum: 0=People, 1=LitePeople.
 */

/**
 * Hand-encode the `RegisterStatementStoreAllowance` variant.
 * Layout: `0x01 0x02 || proof(788) || ringIndex u32 LE || collectionTag u8`.
 */
export function encodeRegisterStmtStore({
  proof,
  ringIndex,
  litePeople,
}: {
  proof: Uint8Array;
  ringIndex: number;
  litePeople: boolean;
}): Uint8Array {
  if (proof.length !== 788) {
    throw new Error(`proof must be 788 bytes, got ${proof.length}`);
  }
  const out = new Uint8Array(1 + 1 + 788 + 4 + 1);
  out[0] = 0x01; // Option::Some
  out[1] = 0x02; // variant: RegisterStatementStoreAllowance
  out.set(proof, 2);
  new DataView(out.buffer).setUint32(2 + 788, ringIndex, true); // u32 LE
  out[2 + 788 + 4] = litePeople ? 1 : 0;
  return out;
}

/**
 * Hand-encode the AsPgas extension's only variant, `Claim` (named struct).
 * Layout: `0x01 0x00 || proof(788) || ringIndex u32 LE || revision u32 LE
 *          || collectionTag u8 || day u32 LE`.
 *
 * Note the asymmetry vs AsResources: PGAS keeps `day` in the extension data
 * (so the runtime can derive the proof context on-chain) while the dispatch
 * call only carries `slot_index` + `target`.
 */
export function encodePgasClaim({
  proof,
  ringIndex,
  revisionIndex,
  litePeople,
  day,
}: {
  proof: Uint8Array;
  ringIndex: number;
  revisionIndex: number;
  litePeople: boolean;
  day: number;
}): Uint8Array {
  if (proof.length !== 788) {
    throw new Error(`proof must be 788 bytes, got ${proof.length}`);
  }
  const out = new Uint8Array(1 + 1 + 788 + 4 + 4 + 1 + 4);
  out[0] = 0x01; // Option::Some
  out[1] = 0x00; // variant: Claim (only variant)
  out.set(proof, 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(2 + 788, ringIndex, true);
  dv.setUint32(2 + 788 + 4, revisionIndex, true);
  out[2 + 788 + 4 + 4] = litePeople ? 1 : 0;
  dv.setUint32(2 + 788 + 4 + 4 + 1, day, true);
  return out;
}

/**
 * Hand-encode the `ClaimLongTermStorage` variant of AsResources.
 * Layout: `0x01 0x03 || proof(788) || ringIndex u32 LE || revisionIndex u32 LE
 *          || collectionTag u8`.
 *
 * The runtime uses `verify_membership_at_rev` for this flow, so the proof can
 * be valid against an older ring revision as long as the chain still retains
 * its old root. `revisionIndex` selects which revision to verify against; the
 * current revision is read from `Members.Root[(id, ring_index)].revision`.
 */
export function encodeClaimLongTermStorage({
  proof,
  ringIndex,
  revisionIndex,
  litePeople,
}: {
  proof: Uint8Array;
  ringIndex: number;
  revisionIndex: number;
  litePeople: boolean;
}): Uint8Array {
  if (proof.length !== 788) {
    throw new Error(`proof must be 788 bytes, got ${proof.length}`);
  }
  const out = new Uint8Array(1 + 1 + 788 + 4 + 4 + 1);
  out[0] = 0x01; // Option::Some
  out[1] = 0x03; // variant: ClaimLongTermStorage
  out.set(proof, 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(2 + 788, ringIndex, true); // u32 LE
  dv.setUint32(2 + 788 + 4, revisionIndex, true); // u32 LE
  out[2 + 788 + 4 + 4] = litePeople ? 1 : 0;
  return out;
}
