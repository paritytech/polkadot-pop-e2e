import type { ChainKey, Selector } from "../types.ts";

/** Candidate relative to live. */
export type ChangeStatus = "added" | "removed" | "changed";

/** An encoding or name change at one type path. */
export interface TypeChange {
  /** Rooted at `args`, `value`, `type`, or `additionalSigned`, e.g. `value.info.some`. */
  path: string;
  /** `changed` includes type replacements, field reordering, and variant index changes. */
  status: ChangeStatus;
  /** Live type or change detail; null when added. */
  before: string | null;
  /** Candidate type or change detail; null when removed. */
  after: string | null;
}

/** A changed metadata entry within the SDK requirements. */
export interface EntryChange {
  selector: Selector;
  status: ChangeStatus;
  /**
   * Input changes, then output changes, capped separately. Added/removed entries list
   * whole input/output types; empty for entries with neither, e.g. argument-free calls.
   */
  types: TypeChange[];
  /** Additional changes were omitted from both JSON and Markdown. */
  truncated: boolean;
}

/** Type changes to an extension present in both runtimes at the same extension version. */
export interface ExtensionChange {
  identifier: string;
  /** Explicit (`type`) and implicit (`additionalSigned`) changes, capped separately. */
  types: TypeChange[];
  /** Additional changes were omitted from both JSON and Markdown. */
  truncated: boolean;
}

/** Changes to one transaction-extension pipeline version. */
export interface PipelineChange {
  version: number;
  status: ChangeStatus;
  /** Ordered identifiers; null when live lacks this version. */
  live: readonly string[] | null;
  /** Ordered identifiers; null when the candidate lacks this version. */
  candidate: readonly string[] | null;
  /** Extra occurrences on the candidate, including duplicate identifiers. */
  added: string[];
  /** Extra occurrences on live, including duplicate identifiers. */
  removed: string[];
  /** Retained identifiers changed order. */
  reordered: boolean;
  /** Retained extensions whose types changed. */
  retyped: ExtensionChange[];
}

/** Changes to accepted extrinsic format versions; lists are sorted ascending. */
export interface ExtrinsicVersionChange {
  live: number[];
  candidate: number[];
  /** Accepted only by the candidate. */
  added: number[];
  /** Accepted only by live. */
  removed: number[];
}

/** Live-to-candidate changes within the SDK requirements, without compatibility verdicts. */
export interface RuntimeDiff {
  chain: ChainKey;
  /** Changed entries, in requirements order. */
  entries: EntryChange[];
  /** Changed extension versions, ascending. Empty when unchanged or no transactions are used. */
  pipelines: PipelineChange[];
  /** Null when unchanged or no transactions are used. */
  extrinsicVersions: ExtrinsicVersionChange | null;
}
