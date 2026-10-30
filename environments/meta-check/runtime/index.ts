// A or A': a runtime, read from its code. The same bytes a release ships as
// `*.compact.compressed.wasm` and a chain stores under `:code`.
//
// Getting the metadata out of the code follows Runtime Watch (paritytech/velocity,
// runtime-watch/src/metadata.ts at f22450a, 2026-10-19): run `Metadata_metadata` in
// polkadot-api's wasm executor and unwrap the opaque bytes it returns.

import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { Blake2256 } from "@polkadot-api/substrate-bindings";
import { getMetadataFromRuntime } from "@polkadot-api/wasm-executor/node";
import { z } from "zod";
import MetadataView from "../metadata-view/index.ts";
import type { RuntimeVersion } from "../types.ts";

const toHex = (bytes: Uint8Array): `0x${string}` => `0x${Buffer.from(bytes).toString("hex")}`;

/** The byte length of the SCALE compact length in front of `bytes`. */
function compactPrefixLength(bytes: Uint8Array): number {
  const first = bytes[0];
  if (first === undefined) throw new Error("compact value is empty");
  const mode = first & 3;
  if (mode === 0) return 1;
  if (mode === 1) return 2;
  if (mode === 2) return 4;
  return 1 + (first >> 2) + 4;
}

/** The SCALE metadata inside a runtime's code. */
function metadataFromCode(code: Uint8Array): Uint8Array {
  // The executor returns OpaqueMetadata: the metadata behind a compact length.
  const opaque = Buffer.from(getMetadataFromRuntime(toHex(code)).slice(2), "hex");
  if (opaque.length === 0) throw new Error("the wasm executor returned no metadata");
  const prefixLength = compactPrefixLength(opaque);
  if (prefixLength >= opaque.length) throw new Error("the wasm executor returned malformed metadata");
  return opaque.subarray(prefixLength);
}

/** The fields of `System.Version` the report shows. */
const SystemVersion = z.object({
  spec_name: z.string(),
  spec_version: z.number(),
  transaction_version: z.number(),
});

export default class Runtime extends MetadataView {
  readonly version: RuntimeVersion;

  /** `code`: the runtime's wasm, compressed or not. */
  constructor(code: Uint8Array) {
    super(metadataFromCode(code));
    const constant = this.metadata.pallets
      .find((pallet) => pallet.name === "System")
      ?.constants.find((c) => c.name === "Version");
    if (!constant) throw new Error("the runtime has no System.Version constant");
    const decoded = getDynamicBuilder(getLookupFn(this.metadata)).buildDefinition(constant.type).dec(constant.value);
    const { spec_name, spec_version, transaction_version } = SystemVersion.parse(decoded);
    this.version = {
      specName: spec_name,
      specVersion: spec_version,
      transactionVersion: transaction_version,
      codeHash: toHex(Blake2256(code)),
    };
  }
}
