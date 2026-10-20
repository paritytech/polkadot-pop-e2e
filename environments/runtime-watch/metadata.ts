// Copied from Runtime Watch: paritytech/velocity, runtime-watch/src/metadata.ts at
// f22450a (2026-10-19). Keep it close to the original so a change there can be
// carried over by diffing the two files.
//
// Changes from the original:
// - @polkadot-api/substrate-bindings 0.21 calls the pipelines `extensionsByVersion`
//   (0.20 called them `signedExtensions`).
// - runtimeVersion returns nulls when System.Version is missing instead of throwing,
//   and also reads spec_name. The gate reads relay and web3-storage runtimes too,
//   which Runtime Watch never sees.
// - runtimeFacts is split into runtimeVersion and extensionPipelines.
//
// Not copied: discoverSdkSurfaces, surfaceShapes and diffFacts. They read only the
// individuality package and call every shape change breaking. runtime-diff.ts reads
// every SDK package and grades each change the way polkadot-api does.

import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { Blake2256, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getMetadataFromRuntime } from "@polkadot-api/wasm-executor/node";

export type UnifiedMetadata = ReturnType<typeof unifyMetadata>;

export function blake2Hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(Blake2256(bytes)).toString("hex")}`;
}

export function compactPrefixLength(bytes: Uint8Array): number {
  if (bytes.length === 0) throw new Error("compact value is empty");
  const mode = bytes[0]! & 3;
  if (mode === 0) return 1;
  if (mode === 1) return 2;
  if (mode === 2) return 4;
  return 1 + (bytes[0]! >> 2) + 4;
}

export function unwrapOpaqueMetadata(hex: `0x${string}`): Uint8Array {
  const opaque = Buffer.from(hex.slice(2), "hex");
  if (opaque.length === 0) throw new Error("WASM executor returned empty metadata");
  const prefixLength = compactPrefixLength(opaque);
  if (prefixLength >= opaque.length) throw new Error("WASM executor returned malformed opaque metadata");
  return opaque.subarray(prefixLength);
}

export function metadataFromRuntime(runtime: Uint8Array): Uint8Array {
  const hex = `0x${Buffer.from(runtime).toString("hex")}` as `0x${string}`;
  return unwrapOpaqueMetadata(getMetadataFromRuntime(hex));
}

export function decodeMetadata(bytes: Uint8Array): UnifiedMetadata {
  return unifyMetadata(decAnyMetadata(bytes));
}

export interface RuntimeVersion {
  specName: string | null;
  specVersion: number | null;
  transactionVersion: number | null;
}

export function runtimeVersion(metadata: UnifiedMetadata): RuntimeVersion {
  const system = metadata.pallets.find((pallet) => pallet.name === "System");
  const versionConstant = system?.constants.find((constant) => constant.name === "Version");
  if (!versionConstant) return { specName: null, specVersion: null, transactionVersion: null };
  const version = getDynamicBuilder(getLookupFn(metadata))
    .buildDefinition(versionConstant.type)
    .dec(versionConstant.value) as { spec_name?: unknown; spec_version?: unknown; transaction_version?: unknown };
  return {
    specName: typeof version.spec_name === "string" ? version.spec_name : null,
    specVersion: typeof version.spec_version === "number" ? version.spec_version : null,
    transactionVersion: typeof version.transaction_version === "number" ? version.transaction_version : null,
  };
}

/** Extension identifiers per extension version, in Runtime Watch's format. */
export function extensionPipelines(metadata: UnifiedMetadata): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(metadata.extrinsic.extensionsByVersion).map(([pipeline, entries]) => [
      pipeline,
      entries.map((entry) => entry.identifier),
    ]),
  );
}
