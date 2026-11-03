import type { EntryChange, ExtrinsicVersionChange, PipelineChange } from "../diff/types.ts";
import type { EntryVerdict, PipelineVerdict } from "../regression/types.ts";
import type { ChainKey, RuntimeVersion } from "../types.ts";
import type { RuntimeAccess } from "../runtime-access/types.ts";

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
  unplaced: RuntimeAccess[];
  /** Upgraded chains that could not be checked, and why. */
  failed: { chain: string; error: string }[];
}
