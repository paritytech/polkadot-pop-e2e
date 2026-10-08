/**
 * Custom PolkadotSigners that submit v5 general transactions whose target
 * extension binds to the live. The signer:
 *
 *   1. Picks the extension version whose pipeline carries the target
 *      extension (0 on legacy runtimes, 1 on runtimes with a separate
 *      Individuality pipeline).
 *   2. Computes `inherited_implication = [extVer] || callData ||
 *      concat(trailing values) || concat(trailing implicits)`.
 *   3. Hashes it via blake2_256 to get the message.
 *   4. Encodes the target extension value from the message (proof or
 *      signature) and replaces the placeholder value.
 *   5. Builds the v5 general blob.
 *
 * Workaround tracked at https://github.com/polkadot-api/polkadot-api/issues/760.
 */
import { type PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import {
  AccountId,
  compact,
  decAnyMetadata,
  extrinsicFormat,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import {
  getDynamicBuilder,
  getLookupFn,
  type LookupEntry,
} from "@polkadot-api/metadata-builders";
import { mergeUint8, toHex } from "polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { verifiableFor } from "./verifiable-loader.js";

/**
 * Prepend a SCALE compact-length prefix to a proof byte array. The
 * `proof: ProofOf<T>` field in AsPgas / AsResources extensions decodes
 * via the verifiable crate as a `BoundedVec<u8, _>`, which SCALE-encodes
 * as `compact_len(N) || N raw bytes`. verifiablejs >= 1.3.0-beta.4
 * returns the raw canonical proof bytes only — we add the prefix here.
 * (verifiablejs <= beta.3 baked the prefix into the returned bytes,
 * which masked the issue; see commit `70f996c` in paritytech/verifiable-js.)
 */
function withCompactLen(proof: Uint8Array): Uint8Array {
  const prefix = compact.enc(proof.length);
  const out = new Uint8Array(prefix.length + proof.length);
  out.set(prefix, 0);
  out.set(proof, prefix.length);
  return out;
}

type SignTx = PolkadotSigner["signTx"];
type Metadata = ReturnType<typeof unifyMetadata>;

/** Returns the highest extension version whose pipeline carries `identifier`. */
function extensionVersion(meta: Metadata, identifier: string): number | undefined {
  const versions = Object.entries(meta.extrinsic.signedExtensions)
    .filter(([, list]) => list.some((e) => e.identifier === identifier))
    .map(([version]) => Number(version));
  return versions.length ? Math.max(...versions) : undefined;
}

/**
 * Returns the "do nothing" value of a metadata type: `None`, `false`, zero, or
 * the first unit enum variant (e.g. `VerifySignature::Disabled`).
 */
function defaultValue(entry: LookupEntry): unknown {
  switch (entry.type) {
    case "void":
    case "option":
      return undefined;
    case "primitive":
      if (entry.value === "bool") return false;
      if (entry.value === "str" || entry.value === "char") return "";
      return /64|128|256/.test(entry.value) ? 0n : 0;
    case "compact":
      return entry.isBig ? 0n : 0;
    case "tuple":
      return entry.value.map(defaultValue);
    case "struct":
      return Object.fromEntries(
        Object.entries(entry.value).map(([k, v]) => [k, defaultValue(v)]),
      );
    case "sequence":
      return [];
    case "enum": {
      const unit = Object.entries(entry.value)
        .filter(([, v]) => v.type === "void")
        .sort(([, a], [, b]) => a.idx - b.idx)[0];
      if (unit) return { type: unit[0] };
    }
  }
  throw new Error(`generalSigner: no default value for type ${entry.id} (${entry.type})`);
}

/**
 * Creates a `signTx` that builds a v5 general transaction in the pipeline
 * carrying `extensionName`, filling that extension with the value returned by
 * `encodeTarget` for the implication message.
 */
function generalSignTx(
  extensionName: string,
  encodeTarget: (
    message: Uint8Array,
    codec: { enc: (value: any) => Uint8Array },
  ) => Uint8Array | Promise<Uint8Array>,
): SignTx {
  return async (callData, signedExtensions, metadata) => {
    const decMeta = unifyMetadata(decAnyMetadata(metadata));
    const version = extensionVersion(decMeta, extensionName);
    if (version === undefined) {
      throw new Error(`generalSigner: extension '${extensionName}' not found in chain metadata`);
    }
    const extList = decMeta.extrinsic.signedExtensions[version];
    const targetIdx = extList.findIndex((e) => e.identifier === extensionName);
    const lookup = getLookupFn(decMeta);
    const builder = getDynamicBuilder(lookup);
    const encodeDefault = (type: number) =>
      builder.buildDefinition(type).enc(defaultValue(lookup(type)));

    // Resolving every extension's bytes
    const resolved = extList.map(({ identifier, type, additionalSigned }) => {
      const ext = signedExtensions[identifier];
      return ext
        ? { value: ext.value, implicit: ext.additionalSigned }
        : { value: encodeDefault(type), implicit: encodeDefault(additionalSigned) };
    });

    // Build inherited_implication for the target extension. Following the
    // for_tuples loop in substrate's TransactionExtension impl for tuples,
    // the encoding flattens to:
    //   TxBaseImplication((extVer, call)) || trailing_explicit || trailing_implicit
    // where "trailing" = positions strictly after the target extension.
    const trailing = resolved.slice(targetIdx + 1);
    const message = blake2b256(
      mergeUint8([
        new Uint8Array([version]),
        callData,
        ...trailing.map((r) => r.value),
        ...trailing.map((r) => r.implicit),
      ]),
    );

    resolved[targetIdx].value = await encodeTarget(
      message,
      builder.buildDefinition(extList[targetIdx].type),
    );

    // Assemble the v5 general blob.
    const preResult = mergeUint8([
      extrinsicFormat.enc({ version: 5, type: "general" }),
      new Uint8Array([version]),
      ...resolved.map((r) => r.value),
      callData,
    ]);
    return mergeUint8([compact.enc(preResult.length), preResult]);
  };
}

/**
 * Creates a signer for an sr25519 account that pays fees in PGAS. Runtimes
 * with a separate Individuality pipeline keep `ChargePGAS` out of version 0,
 * so the transaction goes out as a general one authorized by
 * `VerifyMultiSignature`; legacy runtimes get a plain signed transaction.
 */
export function createPgasPayerSigner(keyPair: {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}): PolkadotSigner {
  const legacy = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  const general = generalSignTx("VerifyMultiSignature", (message, codec) =>
    codec.enc({
      type: "Signed",
      value: {
        signature: { type: "Sr25519", value: toHex(keyPair.sign(message)) },
        account: AccountId().dec(keyPair.publicKey),
      },
    }),
  );
  return {
    ...legacy,
    signTx(callData, signedExtensions, metadata, ...rest) {
      const decMeta = unifyMetadata(decAnyMetadata(metadata));
      return extensionVersion(decMeta, "VerifyMultiSignature")
        ? general(callData, signedExtensions, metadata, ...rest)
        : legacy.signTx(callData, signedExtensions, metadata, ...rest);
    },
  };
}

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
    // Generating the ring-VRF proof bound to (context, message). The
    // verifiablejs build is network-aware — ThinVRF (v0.7.0+) vs
    // pre-ThinVRF (v0.6.5).
    signTx: generalSignTx(opts.extensionName, (message) => {
      const { one_shot } = verifiableFor();
      const result = one_shot(
        opts.verifiableEntropy,
        opts.encodedMembers,
        opts.context,
        message,
      );
      return opts.encodeExtensionValue(result.proof);
    }),
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
 * Layout: `0x01 0x02 || compact_len(proof) || proof(N) || ringIndex u32 LE
 *          || collectionTag u8`.
 *
 * The chain decodes the proof field as `BoundedVec<u8, _>`, so the
 * compact length prefix is required — see `withCompactLen` rationale.
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
  assertProof(proof);
  const prefixed = withCompactLen(proof);
  const out = new Uint8Array(1 + 1 + prefixed.length + 4 + 1);
  out[0] = 0x01; // Option::Some
  out[1] = 0x02; // variant: RegisterStatementStoreAllowance
  out.set(prefixed, 2);
  new DataView(out.buffer).setUint32(2 + prefixed.length, ringIndex, true); // u32 LE
  out[2 + prefixed.length + 4] = litePeople ? 1 : 0;
  return out;
}

/**
 * Hand-encode the AsPgas extension's only variant, `Claim` (named struct).
 * Layout: `0x01 0x00 || compact_len(proof) || proof(N) || ringIndex u32 LE
 *          || revision u32 LE || collectionTag u8 || day u32 LE`.
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
  assertProof(proof);
  const prefixed = withCompactLen(proof);
  const out = new Uint8Array(1 + 1 + prefixed.length + 4 + 4 + 1 + 4);
  out[0] = 0x01; // Option::Some
  out[1] = 0x00; // variant: Claim (only variant)
  out.set(prefixed, 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(2 + prefixed.length, ringIndex, true);
  dv.setUint32(2 + prefixed.length + 4, revisionIndex, true);
  out[2 + prefixed.length + 4 + 4] = litePeople ? 1 : 0;
  dv.setUint32(2 + prefixed.length + 4 + 4 + 1, day, true);
  return out;
}

/**
 * Hand-encode the `ClaimLongTermStorage` variant of AsResources.
 * Layout: `0x01 0x03 || compact_len(proof) || proof(N) || ringIndex u32 LE
 *          || revisionIndex u32 LE || collectionTag u8`.
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
  assertProof(proof);
  const prefixed = withCompactLen(proof);
  const out = new Uint8Array(1 + 1 + prefixed.length + 4 + 4 + 1);
  out[0] = 0x01; // Option::Some
  out[1] = 0x03; // variant: ClaimLongTermStorage
  out.set(prefixed, 2);
  const dv = new DataView(out.buffer);
  dv.setUint32(2 + prefixed.length, ringIndex, true); // u32 LE
  dv.setUint32(2 + prefixed.length + 4, revisionIndex, true); // u32 LE
  out[2 + prefixed.length + 4 + 4] = litePeople ? 1 : 0;
  return out;
}

/**
 * Sanity check ring-VRF proof length. The canonical post-fix ThinVRF
 * size is 785 bytes (verifiablejs >= 1.3.0-beta.4). Older builds
 * appended a 2-byte SCALE compact-length prefix (787) or used the
 * pre-ThinVRF 96-byte signature scheme (788). We now only ship
 * beta.4+ via `verifiable-loader.ts`, so anything other than 785
 * means a misaligned dep — fail loud instead of producing a
 * malformed extrinsic that surfaces later as an opaque chain
 * decode error.
 */
function assertProof(proof: Uint8Array): void {
  if (proof.length !== 785) {
    throw new Error(
      `ring-VRF proof length out of expected range: got ${proof.length}, expected 785 (ThinVRF raw, verifiablejs >= 1.3.0-beta.4)`,
    );
  }
}
