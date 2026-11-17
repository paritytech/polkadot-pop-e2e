import type { EntryChange, ExtrinsicVersionChange, PipelineChange } from "../diff/types.ts";
import type { EntryVerdict, PipelineVerdict } from "../regression/types.ts";
import type { ChainKey, RuntimeVersion } from "../types.ts";
import type { RuntimeAccess } from "../runtime-access/types.ts";

/** An entry's compatibility verdict and runtime changes. */
export interface EntryFinding extends EntryVerdict {
  /** Null if the entry is unchanged or missing from both runtimes. */
  change: EntryChange | null;
}

/** A pipeline's compatibility verdict, extension lists, and runtime changes. */
export interface PipelineFinding extends PipelineVerdict {
  /** SDK's expected pipeline; null if the descriptor has no such version. */
  expected: readonly string[] | null;
  /** Null if the live runtime has no such version. */
  live: readonly string[] | null;
  /** Null if the candidate runtime has no such version. */
  candidate: readonly string[] | null;
  /** Extensions whose candidate types differ from SDK expectations; `change.retyped` compares against live. */
  retypedFromSdk: string[];
  /** Null if the pipeline is unchanged or missing from both runtimes. */
  change: PipelineChange | null;
}

/** Compatibility verdicts and runtime changes for one chain. */
export interface Report {
  chain: ChainKey;
  /** Chain name and runtime code hash used to generate the descriptor. */
  descriptor: { chain: string; codeHash: string };
  live: RuntimeVersion;
  candidate: RuntimeVersion;
  /** Sorted by selector, matching the requirements. */
  entries: EntryFinding[];
  /** Empty if the SDK uses no transactions on this chain. */
  pipelines: PipelineFinding[];
  /** Extrinsic-version changes, without a verdict; null if unchanged or the SDK uses no transactions. */
  extrinsicVersions: ExtrinsicVersionChange | null;
}

/** Results of a check run, including unassigned SDK accesses and chains that could not be checked. */
export interface Run {
  reports: Report[];
  unplaced: RuntimeAccess[];
  /** Upgraded chains that could not be checked, with the reason for each. */
  failed: { chain: string; error: string }[];
}
