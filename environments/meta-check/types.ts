/** Shared metadata-check types. See README.md for the model and flow. */

import type { Var } from "@polkadot-api/metadata-builders";
import type { CompatibilityLevel, EntryPoint } from "@polkadot-api/metadata-compatibility";
import type { unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { ChainDefinition, TypedApi } from "polkadot-api";
import type SdkDescriptor from "./descriptor/index.ts";
import type { EntryChange, ExtrinsicVersionChange, PipelineChange } from "./diff/types.ts";
import type { EntryVerdict, PipelineVerdict } from "./regression/types.ts";

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


/** An SDK source location that accesses a metadata entry. */
export interface Use {
  selector: Selector;
  /** Null when the scanner cannot identify the chain. */
  chain: ChainKey | null;
  /** Optional chaining on the pallet or entry. */
  optional: boolean;
  /** The package name, e.g. `@parity/product-sdk-individuality`. */
  package: string;
  /** Relative to the scanned packages directory. */
  file: string;
  line: number;
}

// ── Requirements (R) ─────────────────────────────────────


/** SDK perspective: encodes inputs, decodes outputs, or both. */
export type Direction = "encode" | "decode" | "both";


/** An SDK requirement for one metadata entry on one chain. */
export interface Requirement {
  selector: Selector;
  get direction(): Direction;
  /** Expected entry from D; null means only existence is checked. */
  expected: Entry | null;
  uses: Use[];
  /** Explicit chain access, or inferred from the descriptor's pallet/runtime API. */
  placedBy: "chain" | "pallet";
  /** All uses are optional; a missing entry is allowed. */
  get optional(): boolean;
}


/** SDK requirements for one chain. */
export interface Requirements {
  chain: ChainKey;
  /** Descriptor used to resolve expected types. */
  descriptor: SdkDescriptor;
  /** Sorted by selector. */
  entries: Requirement[];
  /** Has a tx requirement; enables pipeline checks and extrinsic-version diffing. */
  get usesTransactions(): boolean;
}


/** R: the requirements for each chain the caller gave a descriptor for. */
export interface RequirementSet {
  chains: Requirements[];
  /** Reads no chain took: their chain has no descriptor, or no descriptor has their pallet. */
  unplaced: Use[];
}

// ── Grades ───────────────────────────────────────────────

/**
 * PAPI compatibility level, or:
 * - Missing: the runtime lacks the entry.
 * - Present: the entry exists, but D has no type to compare against.
 */
export type Level = keyof typeof CompatibilityLevel | "Missing" | "Present";

// ── Compatibility checks ─────────────────────────────────

/** One requirement graded against one runtime. */
export interface EntryCheck {
  requirement: Requirement;
  level: Level;
}

/** One extension version graded against one runtime. */
export interface PipelineCheck {
  version: number;
  /** Descriptor's pipeline; null when it has no such version. */
  expected: readonly string[] | null;
  /** The runtime's pipeline; null when it has no such version. */
  actual: readonly string[] | null;
  level: Level;
  /** Extension identifiers present in both pipelines whose types are not Identical. */
  retyped: string[];
}

/** Compatibility results for one chain and runtime. */
export interface RuntimeCheck {
  chain: ChainKey;
  /** Descriptor chain and the runtime code hash it was generated from. */
  descriptor: { chain: string; codeHash: string };
  runtime: RuntimeVersion;
  /** Sorted by selector. */
  entries: EntryCheck[];
  /** All descriptor/runtime extension versions, ascending. Empty when the SDK uses no transactions. */
  pipelines: PipelineCheck[];
}

// ── Report ───────────────────────────────────────────────

/** An entry's verdict, and what the upgrade changed in it. */
export interface EntryFinding extends EntryVerdict {
  /** Null when A and A' have the entry alike, or both lack it. */
  change: EntryChange | null;
}

/** A pipeline's verdict, and the lists behind it. */
export interface PipelineFinding extends PipelineVerdict {
  /** What D signs with; null when D has no such version, so the SDK does not use it. */
  expected: readonly string[] | null;
  /** A's pipeline; null when A has no such version. */
  live: readonly string[] | null;
  /** A''s pipeline; null when A' has no such version. */
  candidate: readonly string[] | null;
  /** Extensions in both D and A' whose types are not Identical: A''s against D's, unlike `change.retyped`. */
  retypedFromSdk: string[];
  /** What the upgrade changed in this version; null when A and A' have it alike, or both lack it. */
  change: PipelineChange | null;
}

/** The result for one chain: each requirement's and extension version's verdict, and what lies behind it. */
export interface Report {
  chain: ChainKey;
  /** D: the descriptor chain and the code hash it was generated from. */
  descriptor: { chain: string; codeHash: string };
  live: RuntimeVersion;
  candidate: RuntimeVersion;
  /** In the requirements' order: by selector. */
  entries: EntryFinding[];
  /** Empty when the SDK does not sign on this chain. */
  pipelines: PipelineFinding[];
  /** What the upgrade changed in the extrinsic versions; ungraded. Null when nothing, or no transactions. */
  extrinsicVersions: ExtrinsicVersionChange | null;
}

/** One check run: a report per upgraded chain, and the reads no chain took. */
export interface Run {
  reports: Report[];
  unplaced: Use[];
  /** Upgraded chains that could not be checked, and why. */
  failed: { chain: string; error: string }[];
}
