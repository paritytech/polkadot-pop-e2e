import type { Level, Requirement } from "../types.ts";

/**
 * - `ok`: meets the compatibility policy, including allowed absence.
 * - `breaking`: below BackwardsCompatible and worse than live.
 * - `pre-existing`: below BackwardsCompatible, but no worse than live.
 */
export type Verdict = "ok" | "breaking" | "pre-existing";

/** Compatibility levels and regression verdict for one requirement. */
export interface EntryVerdict {
  requirement: Requirement;
  /** Compatibility on live. */
  before: Level;
  /** Compatibility on candidate. */
  after: Level;
  verdict: Verdict;
}

/** Compatibility levels and regression verdict for one extension version. */
export interface PipelineVerdict {
  version: number;
  /** Compatibility on live. */
  before: Level;
  /** Compatibility on candidate. */
  after: Level;
  verdict: Verdict;
}

/** Regression results for one chain. */
export interface Regression {
  /** In the requirements' order. */
  entries: EntryVerdict[];
  /** All descriptor/live/candidate extension versions, ascending. Empty when the SDK uses no transactions. */
  pipelines: PipelineVerdict[];
}
