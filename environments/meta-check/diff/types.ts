import type { ChainKey, Selector } from "../types.ts";

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
