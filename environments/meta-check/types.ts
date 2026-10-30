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
import type SdkUsage from "./usage/index.ts";

export type Metadata = ReturnType<typeof unifyMetadata>;

// ── Inputs ───────────────────────────────────────────────

export type Kind = "tx" | "query" | "event" | "constant" | "api" | "view";

/** An entry on a chain, as the SDK names it: `tx:Game.sign_up`, `query:Score.Participants`. */
export type Selector = `${Kind}:${string}.${string}`;

export interface RuntimeVersion {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  codeHash: string;
}

/** A or A': one runtime's metadata, and its version for the report. */
export interface Runtime {
  version: RuntimeVersion;
  metadata: Metadata;
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

/** One entry the SDK needs from the runtime. */
export interface Requirement {
  selector: Selector;
  /** The SDK packages that read it. */
  usedBy: string[];
  /** The type D expects; null when D does not have the entry, so only its name is checked. */
  expected: Shape | null;
  direction: Direction;
}

/** R: everything the SDK needs from one chain. */
export interface Requirements {
  chain: string;
  /** Rules 1 (names) and 2 (types). */
  entries: Requirement[];
  /** Rule 3 (transaction extensions), from D. */
  pipelines: Pipelines;
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

export type BuildRequirements = (descriptor: SdkDescriptor, usage: SdkUsage) => Requirements;

/** Without a live runtime, pass D's own metadata as `live`: then nothing is pre-existing. */
export type Check = (requirements: Requirements, live: Runtime, candidate: Runtime) => Report;
