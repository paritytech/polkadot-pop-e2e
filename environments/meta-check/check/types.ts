import type { ChainKey, Level, Requirement, RuntimeVersion } from "../types.ts";

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
