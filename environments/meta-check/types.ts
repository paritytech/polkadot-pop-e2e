/**
 * Shared types for checking a candidate runtime against product-sdk's expectations.
 *
 * - D: the metadata used to generate the SDK's descriptors.
 * - U: chain-entry reads found by scanning the SDK's code.
 * - R: the SDK's requirements for each target chain: which entries it uses
 * and what types it expects, derived from U and that chain's D.
 * - A / A': the live / candidate runtime.
 *
 * `buildRequirements(D, U) -> R`, then for each upgraded chain:
 *
 * - `check(R, A)`: how well one runtime fits R. Live and candidate are each checked.
 * - `regression(onLive, onCandidate)`: comparing those two checks distinguishes new
 * regressions from existing mismatches.
 * - `diff(R, A, A')`: where the entries R uses changed between the two runtimes.
 *
 * This is a static metadata check, not a guarantee of runtime behaviour.
 * See `docs/design/runtime-diff.md` for the design; implementation details below
 * describe the current checker.
 */

import type { EntryPoint } from "@polkadot-api/metadata-compatibility";
import type { unifyMetadata } from "@polkadot-api/substrate-bindings";
import type SdkDescriptor from "./descriptor/index.ts";

export type Metadata = ReturnType<typeof unifyMetadata>;

// ── Inputs ───────────────────────────────────────────────

export type Kind = "tx" | "query" | "event" | "constant" | "api" | "view";

/** An entry on a chain, as the SDK names it: `tx:Game.sign_up`, `query:Score.Participants`. */
export type Selector = `${Kind}:${string}.${string}`;

/** What identifies a runtime (A or A') in the report: `System.Version`, and the hash of its code. */
export interface RuntimeVersion {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  /** blake2-256 of the code, as polkadot-api.json records it for D. */
  codeHash: string;
}

/**
 * The type of one entry, the way polkadot-api compares them: the type ids of what goes
 * in (`args`) and what comes out (`values`). The ids mean something only in the
 * `MetadataView` the entry came from.
 */
export type Shape = EntryPoint;

/** One entry in a runtime's metadata, or in D. */
export interface Entry {
  selector: Selector;
  kind: Kind;
  /** The pallet, or the runtime API. */
  group: string;
  name: string;
  shape: Shape;
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
  /** The SDK builds transactions here (a `tx:` requirement), so the extension pipelines matter. */
  signs: boolean;
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

// ── One runtime: check(R, A) ─────────────────────────────

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

/** One entry R uses whose type differs between A and A'. */
export interface EntryChange {
  selector: Selector;
  /** The type paths where A and A' differ, deepest only: `args.dest`, `value.data.free`. */
  changedAt: string[];
}

/** `diff(R, A, A')`: the entries R uses that both runtimes have, and whose types differ. */
export interface RuntimeDiff {
  chain: ChainKey;
  /** In the requirements' order. */
  entries: EntryChange[];
}

// ── Report ───────────────────────────────────────────────

/** An entry's verdict, and where its type changed. */
export interface EntryFinding extends EntryVerdict {
  /** The type paths where A and A' differ, deepest only; empty when it did not change. */
  changedAt: string[];
}

/** A pipeline's verdict, and the lists behind it. */
export interface PipelineFinding extends PipelineVerdict {
  /** What D signs with; null when D has no such version, so the SDK does not use it. */
  expected: readonly string[] | null;
  /** A's pipeline; null when A has no such version. */
  live: readonly string[] | null;
  /** A''s pipeline; null when A' has no such version. */
  candidate: readonly string[] | null;
  /** Extensions in both D and A' whose types are not Identical. */
  retyped: string[];
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
}

/** One check run: a report per upgraded chain, and the reads no chain took. */
export interface Run {
  reports: Report[];
  unplaced: Use[];
  /** Upgraded chains that could not be checked, and why. */
  failed: { chain: string; error: string }[];
}
