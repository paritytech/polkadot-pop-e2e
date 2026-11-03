// A run as JSON for the artifact: a stable shape of its own, so internal types can change
// without changing what readers of the artifact get. Shapes and descriptors stay out.
//
// Per chain, two comparisons: D (the SDK's descriptor) against each runtime, which the
// verdicts come from, and live (A) against the candidate (A'), under `change`.
// - `entries[]`: each entry the SDK uses. `before` and `after`: D against A and A'.
//   `change`: how A and A' differ in it, or null: `status` and, where its types differ,
//   `types[]` (`path`, `status`, `before`, `after`), up to 100 for its args and 100 for its
//   value; `truncated` when there were more.
// - `pipelines[]`: each transaction extension version, graded the same way, with the
//   identifier lists `expected` (D's), `live` and `candidate`. `retypedFromSdk`: identifiers
//   whose types on A' are not Identical to D's. `change`: A against A', or null: the
//   identifiers `added`, `removed` and `reordered`, and in `retyped[]` the extensions whose
//   types differ, with their `types[]` as an entry's.
// - `extrinsicVersions`: the versions A and A' accept when they differ, ungraded; else null.
// Empty `pipelines` and a null `extrinsicVersions` also mean the SDK uses no transactions there.

import type { EntryChange, PipelineChange, TypeChange } from "../diff/types.ts";
import type { Run, Use } from "../types.ts";

export const SCHEMA_VERSION = 1;

const use = ({ selector, chain, optional, package: pkg, file, line }: Use) => ({
  selector,
  chain,
  optional,
  package: pkg,
  file,
  line,
});

const types = (list: TypeChange[]) => list.map(({ path, status, before, after }) => ({ path, status, before, after }));

const entryChange = (change: EntryChange | null) =>
  change && { status: change.status, types: types(change.types), truncated: change.truncated };

/** The lists themselves are the pipeline's `live` and `candidate`. */
const pipelineChange = (change: PipelineChange | null) =>
  change && {
    status: change.status,
    added: change.added,
    removed: change.removed,
    reordered: change.reordered,
    retyped: change.retyped.map((extension) => ({
      identifier: extension.identifier,
      types: types(extension.types),
      truncated: extension.truncated,
    })),
  };

export default function toJson(run: Run) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chains: run.reports.map((report) => ({
      chain: report.chain,
      descriptor: report.descriptor,
      live: report.live,
      candidate: report.candidate,
      entries: report.entries.map(({ requirement, before, after, verdict, change }) => ({
        selector: requirement.selector,
        verdict,
        before,
        after,
        change: entryChange(change),
        direction: requirement.direction,
        optional: requirement.optional,
        placedBy: requirement.placedBy,
        uses: requirement.uses.map(({ package: pkg, file, line }) => ({ package: pkg, file, line })),
      })),
      pipelines: report.pipelines.map(({ version, verdict, before, after, expected, live, candidate, retypedFromSdk, change }) => ({
        version,
        verdict,
        before,
        after,
        expected,
        live,
        candidate,
        retypedFromSdk,
        change: pipelineChange(change),
      })),
      extrinsicVersions: report.extrinsicVersions && {
        live: report.extrinsicVersions.live,
        candidate: report.extrinsicVersions.candidate,
        added: report.extrinsicVersions.added,
        removed: report.extrinsicVersions.removed,
      },
    })),
    unplaced: run.unplaced.map(use),
    failed: run.failed,
  };
}
