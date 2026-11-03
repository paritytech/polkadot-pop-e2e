/** Shared metadata-check types. See README.md for the model and flow. */

import type { Var } from "@polkadot-api/metadata-builders";
import type { CompatibilityLevel, EntryPoint } from "@polkadot-api/metadata-compatibility";
import type { unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { ChainDefinition, TypedApi } from "polkadot-api";

export type Metadata = ReturnType<typeof unifyMetadata>;

// ── Inputs ───────────────────────────────────────────────

export type Kind = Exclude<keyof TypedApi<ChainDefinition>, "txFromCallData" | "getStaticApis">;

/** A chain entry, e.g. `tx:Game.sign_up` or `constants:Score.Suffix`. */
export type Selector = `${Kind}:${string}.${string}`;

export interface RuntimeVersion {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  /** Blake2-256 of the runtime code. */
  codeHash: string;
}

/**
 * Input/output types. Individuality examples:
 * - `tx:Coinage.transfer`: input: { to: AccountId32 }, output: null.
 * - `constants:System.BlockHashCount`: input: null, output: u32.
 */
export interface Encoding {
  input: Var | null;
  output: Var | null;
}

/** A chain entry from runtime or descriptor metadata. */
export interface Entry {
  selector: Selector;
  /** PAPI compatibility types; may normalize different encodings to the same type. */
  shape: EntryPoint;
  /** Codec-building types; preserve widths, field order, and variant indices for diffing. */
  encoding: Encoding;
  get direction(): Direction;
}

/** Transaction-extension identifiers in encoding order, keyed by extension version. */
export type Pipelines = Record<number, readonly string[]>;


/** SDK chain-client key, e.g. `individuality` in `chain.individuality.query...`. */
export type ChainKey = "individuality" | "assetHub" | "bulletin";


/** SDK perspective: encodes inputs, decodes outputs, or both. */
export type Direction = "encode" | "decode" | "both";

// ── Grades ───────────────────────────────────────────────

/**
 * PAPI compatibility level, or:
 * - Missing: the runtime lacks the entry.
 * - Present: the entry exists, but D has no type to compare against.
 */
export type Level = keyof typeof CompatibilityLevel | "Missing" | "Present";
