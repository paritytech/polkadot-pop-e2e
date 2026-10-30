// The types of the metadata check: what a candidate runtime changes for the product-sdk.
//
//   requirements(D, U) -> R
//   check(R, A, A')    -> Report
//
// A is the live runtime, A' the candidate, D the SDK's descriptors and U the names the
// SDK's code reads. docs/design/runtime-diff.md explains the rules.

import type { EntryPoint } from "@polkadot-api/metadata-compatibility";
import type { unifyMetadata } from "@polkadot-api/substrate-bindings";
import type SdkDescriptor from "./descriptor/index.ts";
import type Runtime from "./runtime/index.ts";

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

// ── Result ───────────────────────────────────────────────

/** polkadot-api's compatibility levels, plus `Missing` for an entry the runtime does not have. */
export type Level = "Identical" | "BackwardsCompatible" | "Partial" | "Incompatible" | "Missing";

/**
 * - `ok`: the SDK can use the entry on the candidate.
 * - `breaking`: the candidate fits the SDK worse than live did, and below BackwardsCompatible.
 * - `pre-existing`: it does not fit, but it already did not fit on live.
 */
export type Verdict = "ok" | "breaking" | "pre-existing";

export interface EntryFinding {
  requirement: Requirement;
  /** D against A. */
  before: Level;
  /** D against A'. */
  after: Level;
  verdict: Verdict;
  /** The type paths where A and A' differ, deepest first. */
  changedAt: string[];
}

export interface PipelineFinding {
  version: number;
  /** What D signs with; null when D has no such version. */
  expected: readonly string[] | null;
  /** A's pipeline; null when A has no such version. */
  before: readonly string[] | null;
  /** A''s pipeline; null when A' has no such version. */
  after: readonly string[] | null;
  verdict: Verdict;
}

/** The result for one chain. */
export interface Report {
  chain: string;
  live: RuntimeVersion;
  candidate: RuntimeVersion;
  entries: EntryFinding[];
  pipelines: PipelineFinding[];
}

// ── Functions ────────────────────────────────────────────

/** Without a live runtime, pass D's own metadata as `live`: then nothing is pre-existing. */
export type Check = (requirements: Requirements, live: Runtime, candidate: Runtime) => Report;
