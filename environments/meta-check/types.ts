/** Shared metadata-check types. See README.md for the model and flow. */

import type { Var } from "@polkadot-api/metadata-builders";
import type { EntryPoint } from "@polkadot-api/metadata-compatibility";
import type { unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { ChainDefinition, TypedApi } from "polkadot-api";
import type SdkDescriptor from "./descriptor/index.ts";

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

/** One entry in a runtime's metadata, or in D. */
export interface Entry {
  selector: Selector;
  kind: Kind;
  /** The pallet, or the runtime API. */
  group: string;
  name: string;
  /** Type IDs belong to the originating MetadataView. */
  shape: EntryPoint;
  encoding: Encoding;
  direction: Direction;
}

/** Extension version -> the extension identifiers, in the order the signer builds them. */
export type Pipelines = Record<number, readonly string[]>;

/**
 * The chain-client key an SDK read goes through, as in `chain.individuality.query...`.
 * Which descriptor it means (paseo-individuality, previewnet-individuality) depends on
 * the network, so it is mapped when the requirements are built.
 */
export type ChainKey = "individuality" | "assetHub" | "bulletin";

/** One place in the SDK's code that reads a chain entry. U is all of them. */
export interface Use {
  selector: Selector;
  /** Null when the code reads through a local API and does not show which chain. */
  chain: ChainKey | null;
  /** Read with `?.` on the pallet or the entry: the code copes with the entry being absent. */
  optional: boolean;
  /** The package name, e.g. `@parity/product-sdk-individuality`. */
  package: string;
  /** Relative to the scanned packages directory. */
  file: string;
  line: number;
}

// ── Requirements (R) ─────────────────────────────────────

/**
 * Who encodes and who decodes, which decides which value set must fit inside which.
 * It follows from the kind: the SDK encodes a call's arguments, decodes an event or a
 * constant, and does both for storage (keys, value) and runtime APIs (inputs, output).
 */
export type Direction = "encode" | "decode" | "both";

/** One entry the SDK needs from one chain's runtime. */
export interface Requirement {
  selector: Selector;
  direction: Direction;
  /** D's entry: the type the SDK expects. Null when D does not have it, so only its name is checked. */
  expected: Entry | null;
  /** Every place in the SDK that reads it. */
  uses: Use[];
  /**
   * `chain`: the code named the chain (`chain.individuality...`). `pallet`: it did not, and
   * the requirement is on this chain because D has the pallet (or runtime API).
   */
  placedBy: "chain" | "pallet";
  /** Every use reads it with `?.`: the SDK copes with the entry being absent. */
  optional: boolean;
}

/** R for one chain: Rules 1 and 2 from `entries`, Rule 3 from the descriptor's pipelines. */
export interface Requirements {
  chain: ChainKey;
  /** D for this chain; grading resolves `expected`'s type ids through it. */
  descriptor: SdkDescriptor;
  /** Sorted by selector. */
  entries: Requirement[];
  /**
   * The SDK builds transactions here, signed or not (a `tx:` requirement), so the extension
   * pipelines and extrinsic versions matter. A chain the SDK only ships a signer for has none.
   */
  usesTransactions: boolean;
}

/** R: the requirements for each chain the caller gave a descriptor for. */
export interface RequirementSet {
  chains: Requirements[];
  /** Reads no chain took: their chain has no descriptor, or no descriptor has their pallet. */
  unplaced: Use[];
}

// ── Grades ───────────────────────────────────────────────

/**
 * polkadot-api's compatibility levels, plus `Missing` for an entry the runtime does not
 * have and `Present` for one it has whose type cannot be checked, because D lacks it.
 */
export type Level = "Identical" | "BackwardsCompatible" | "Partial" | "Incompatible" | "Missing" | "Present";

/**
 * - `ok`: the SDK can use the entry on the candidate.
 * - `breaking`: the candidate fits the SDK worse than live did, and below BackwardsCompatible.
 * - `pre-existing`: it does not fit, but it already did not fit on live.
 */
export type Verdict = "ok" | "breaking" | "pre-existing";

// ── check(R, A) ─────────────────────────────

/** One requirement graded against one runtime. */
export interface EntryCheck {
  requirement: Requirement;
  /** D against the runtime. */
  level: Level;
}

/** One extension version graded against one runtime, Rule 3. */
export interface PipelineCheck {
  version: number;
  /** What D signs with; null when D has no such version, so the SDK does not use it. */
  expected: readonly string[] | null;
  /** The runtime's pipeline; null when it has no such version. */
  actual: readonly string[] | null;
  /** D against the runtime. */
  level: Level;
  /** Extensions in both D and the runtime whose types are not Identical. */
  retyped: string[];
}

/** One chain's requirements against one runtime, live (A) or the candidate (A'). */
export interface RuntimeCheck {
  chain: ChainKey;
  /** D: the descriptor chain and the code hash it was generated from. */
  descriptor: { chain: string; codeHash: string };
  runtime: RuntimeVersion;
  /** In the requirements' order: by selector. */
  entries: EntryCheck[];
  /** Every version D or the runtime has, ascending. Empty when the SDK does not sign on this chain. */
  pipelines: PipelineCheck[];
}

// ── Live against candidate: regression and diff ──────────

/** One requirement on live and on the candidate, and what the upgrade did to it. */
export interface EntryVerdict {
  requirement: Requirement;
  /** D against A. */
  before: Level;
  /** D against A'. */
  after: Level;
  verdict: Verdict;
}

/** One extension version on live and on the candidate, and what the upgrade did to it, Rule 3. */
export interface PipelineVerdict {
  version: number;
  /** D against A. */
  before: Level;
  /** D against A'. */
  after: Level;
  verdict: Verdict;
}

/** `regression(onLive, onCandidate)`: the verdict on each requirement and extension version. */
export interface Regression {
  /** In the requirements' order. */
  entries: EntryVerdict[];
  /** Every version D, A or A' has, ascending. Empty when the SDK does not sign on this chain. */
  pipelines: PipelineVerdict[];
}

/** `added`: only A' has it. `removed`: only A has it. `changed`: both have it, and it differs. */
export type ChangeStatus = "added" | "removed" | "changed";

/** One place where a type differs between A and A' in how it encodes, or in its names. */
export interface TypeChange {
  /**
   * From the entry's `args` or `value`, or the extension's `type` or `additionalSigned`,
   * in PAPI's path segments: `args.dest`, `value.info.some`, `value.ok.value`.
   */
  path: string;
  /**
   * For `changed`: the type was replaced by another (another kind, width or length), the
   * struct's fields moved (`{ a, b }` → `{ b, a }`), or the variant's index changed
   * (`index 3` → `index 4`).
   */
  status: ChangeStatus;
  /** A's type there, or what about it differs; null when only A' has it. */
  before: string | null;
  /** A''s type there, or what about it differs; null when only A has it. */
  after: string | null;
}

/** One entry R uses that differs between A and A'. */
export interface EntryChange {
  selector: Selector;
  status: ChangeStatus;
  /**
   * Where its types differ, in walk order: `args`, then `value`, up to 100 each. For an
   * added or removed entry, its whole `args` and `value`: empty when it has neither, as a
   * call without arguments or an event without fields.
   */
  types: TypeChange[];
  /** A side had more changes than `types` lists; they are in neither the JSON nor the markdown. */
  truncated: boolean;
}

/** One extension in A's and A''s version whose types differ. */
export interface ExtensionChange {
  identifier: string;
  /** Where its `type` (the explicit value) or `additionalSigned` (the implicit one) differ, up to 100 each. */
  types: TypeChange[];
  /** A side had more changes than `types` lists. */
  truncated: boolean;
}

/** One extension version that differs between A and A'. */
export interface PipelineChange {
  version: number;
  status: ChangeStatus;
  /** A's extension identifiers in order; null when A has no such version. */
  live: readonly string[] | null;
  /** A''s extension identifiers in order; null when A' has no such version. */
  candidate: readonly string[] | null;
  /** In A''s list and not in A's; one listed more often in A' than in A, once for each time more. */
  added: string[];
  /** In A's list and not in A''s; one listed more often in A than in A', once for each time more. */
  removed: string[];
  /** The extensions both lists keep are in another order. */
  reordered: boolean;
  /** Extensions in both lists whose types differ: live's against the candidate's. */
  retyped: ExtensionChange[];
}

/** The extrinsic format versions A and A' accept (4, 5), ascending, when they differ. */
export interface ExtrinsicVersionChange {
  live: number[];
  candidate: number[];
  /** A' accepts them, A does not. */
  added: number[];
  /** A accepts them, A' does not. */
  removed: number[];
}

/** `diff(R, A, A')`: what differs between the two runtimes within what the SDK uses. */
export interface RuntimeDiff {
  chain: ChainKey;
  /** The entries R uses that differ, in the requirements' order. */
  entries: EntryChange[];
  /** The extension versions that differ, ascending. Empty when the SDK uses no transactions on this chain. */
  pipelines: PipelineChange[];
  /** Null when they are alike, or when the SDK uses no transactions on this chain. Not graded: no verdict. */
  extrinsicVersions: ExtrinsicVersionChange | null;
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
