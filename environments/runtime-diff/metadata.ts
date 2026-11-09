// Reading the metadata out of a runtime blob. Copied from Runtime Watch
// (paritytech/velocity, runtime-watch/src/metadata.ts at f22450a, 2026-10-19).
// Changes: no type assertions, and runtimeVersion returns nulls when System.Version
// is missing instead of throwing, for the relay and web3-storage runtimes.

import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { Blake2256, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getMetadataFromRuntime } from "@polkadot-api/wasm-executor/node";
import { isRecord, stringOr } from "./json.ts";

export type UnifiedMetadata = ReturnType<typeof unifyMetadata>;

const toHex = (bytes: Uint8Array): `0x${string}` => `0x${Buffer.from(bytes).toString("hex")}`;

export const blake2Hex = (bytes: Uint8Array): string => toHex(Blake2256(bytes));

export function compactPrefixLength(bytes: Uint8Array): number {
  const first = bytes[0];
  if (first === undefined) throw new Error("compact value is empty");
  const mode = first & 3;
  if (mode === 0) return 1;
  if (mode === 1) return 2;
  if (mode === 2) return 4;
  return 1 + (first >> 2) + 4;
}

export function metadataFromRuntime(runtime: Uint8Array): Uint8Array {
  const opaque = Buffer.from(getMetadataFromRuntime(toHex(runtime)).slice(2), "hex");
  if (opaque.length === 0) throw new Error("WASM executor returned empty metadata");
  const prefixLength = compactPrefixLength(opaque);
  if (prefixLength >= opaque.length) throw new Error("WASM executor returned malformed opaque metadata");
  return opaque.subarray(prefixLength);
}

export const decodeMetadata = (bytes: Uint8Array): UnifiedMetadata => unifyMetadata(decAnyMetadata(bytes));

export interface RuntimeVersion {
  specName: string | null;
  specVersion: number | null;
  transactionVersion: number | null;
}

export function runtimeVersion(metadata: UnifiedMetadata): RuntimeVersion {
  const system = metadata.pallets.find((pallet) => pallet.name === "System");
  const constant = system?.constants.find((c) => c.name === "Version");
  const version: unknown = constant
    ? getDynamicBuilder(getLookupFn(metadata)).buildDefinition(constant.type).dec(constant.value)
    : null;
  const number = (key: string): number | null => {
    const value = isRecord(version) ? version[key] : null;
    return typeof value === "number" ? value : null;
  };
  return {
    specName: isRecord(version) ? stringOr(version.spec_name, null) : null,
    specVersion: number("spec_version"),
    transactionVersion: number("transaction_version"),
  };
}
