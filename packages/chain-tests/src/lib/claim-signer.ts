/**
 * Transaction creators for v5 general transactions authorized by one
 * extension: a ring-VRF proof (`AsPgas`, `AsResources`) or an sr25519
 * signature (`VerifyMultiSignature`) over the inherited implication.
 */
import {
  getTxCreator,
  signatureExtensionTxCreator,
  type TxCreator,
} from "polkadot-api/tx-creator";
import {
  withCommonExtensions,
  withNonce,
  type CommonEnhancersSpecs,
  type CommonSignerTxCreator,
} from "@polkadot-api/signers-common";
import { AccountId, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import {
  getDynamicBuilder,
  getLookupFn,
  type LookupEntry,
} from "@polkadot-api/metadata-builders";
import { toHex } from "polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { verifiableFor } from "./verifiable-loader.js";
import type { Collection } from "./ring.js";

const decodeMetadata = (metadata: string) => unifyMetadata(decAnyMetadata(metadata));

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
  throw new Error(`claimSigner: no default value for type ${entry.id} (${entry.type})`);
}

/**
 * Fills every extension the payload still lacks with its "do nothing" value,
 * so the pipeline carrying `target` can be selected and encoded.
 */
const withDefaultExtensions =
  (target: string) =>
  (inner: TxCreator): TxCreator =>
  (payload, opts, bindings, mocked) => {
    const meta = decodeMetadata(payload.context.metadata);
    const lookup = getLookupFn(meta);
    const builder = getDynamicBuilder(lookup);
    const encodeDefault = (type: number) =>
      toHex(builder.buildDefinition(type).enc(defaultValue(lookup(type))));
    const present = new Set(payload.extensions.map((e) => e.id));
    const missing = Object.values(meta.extrinsic.extensions)
      .filter(({ identifier }) => identifier !== target && !present.has(identifier))
      .map(({ identifier, type, additionalSigned }) => ({
        id: identifier,
        extra: encodeDefault(type),
        additionalSigned: encodeDefault(additionalSigned),
      }));
    return inner(
      { ...payload, extensions: [...payload.extensions, ...missing] },
      opts,
      bindings,
      mocked,
    );
  };

/** A creator for a general transaction whose `extensionName` carries `encodeTarget(message)`. */
function generalTxCreator(
  publicKey: Uint8Array,
  extensionName: string,
  encodeTarget: (
    message: Uint8Array,
    codec: { enc: (value: any) => Uint8Array },
  ) => Uint8Array | Promise<Uint8Array>,
) {
  const creator = signatureExtensionTxCreator(extensionName, (implication, _mocked, _bindings, meta) => {
    const lookup = getLookupFn(meta);
    const ext = Object.values(meta.extrinsic.extensions).find((e) => e.identifier === extensionName)!;
    return encodeTarget(blake2b256(implication), getDynamicBuilder(lookup).buildDefinition(ext.type));
  });
  return withNonce(publicKey)(
    withCommonExtensions(withDefaultExtensions(extensionName)(creator as TxCreator) as TxCreator<[]>),
  );
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
}): CommonSignerTxCreator {
  const legacy = getTxCreator(keyPair.publicKey, "Sr25519", keyPair.sign);
  const general = generalTxCreator(keyPair.publicKey, "VerifyMultiSignature", (message, codec) =>
    codec.enc({
      type: "Signed",
      value: {
        signature: { type: "Sr25519", value: toHex(keyPair.sign(message)) },
        account: AccountId().dec(keyPair.publicKey),
      },
    }),
  );
  const create: TxCreator = (payload, opts, bindings, mocked) => {
    const meta = decodeMetadata(payload.context.metadata);
    const isGeneral = Object.values(meta.extrinsic.extensions).some(
      (e) => e.identifier === "VerifyMultiSignature",
    );
    return (isGeneral ? general : legacy)(payload, opts as never, bindings, mocked);
  };
  return Object.assign(create, {
    publicKey: legacy.publicKey,
    signBytes: legacy.signBytes,
  }) as unknown as CommonSignerTxCreator;
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
  /** The collection's ring size exponent, from `ringExponent`. */
  ringExponent: number;
  /** The extension's value for `proof`, encoded with the live metadata's codec. */
  extensionValue: (proof: Uint8Array) => unknown;
}

/**
 * Creates the unsigned general transaction a host submits for an allowance
 * claim: immortal, like truapi's, with the ring-VRF proof in `extensionName`.
 */
export function createClaimSigner(opts: ClaimSignerOpts): TxCreator<CommonEnhancersSpecs> {
  const inner = generalTxCreator(new Uint8Array(32), opts.extensionName, (message, codec) => {
    const { one_shot } = verifiableFor();
    const { proof } = one_shot(opts.ringExponent, opts.verifiableEntropy, opts.encodedMembers, opts.context, message);
    assertProof(proof);
    return codec.enc(opts.extensionValue(proof));
  });
  return (payload, txOpts, bindings, mocked) =>
    inner(payload, { ...txOpts, mortality: { mortal: false } }, bindings, mocked);
}

export interface RingRef {
  ringIndex: number;
  revision: number;
  collection: Collection;
}

/** An `AsResources` variant carrying `(proof, ring_index, revision, collection)`. */
export const asResources =
  (variant: "ClaimLongTermStorage", { ringIndex, revision, collection }: RingRef) =>
  (proof: Uint8Array) => ({
    type: variant,
    value: [proof, ringIndex, revision, { type: collection }],
  });

/**
 * Sanity check ring-VRF proof length. The canonical ThinVRF size is 785
 * bytes (verifiablejs >= 1.3.0-beta.4); anything else means a misaligned dep.
 */
function assertProof(proof: Uint8Array): void {
  if (proof.length !== 785) {
    throw new Error(`ring-VRF proof is ${proof.length} bytes, expected 785`);
  }
}
