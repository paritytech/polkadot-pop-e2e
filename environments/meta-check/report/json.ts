// A run as JSON for the artifact: a stable shape of its own, so internal types can change
// without changing what readers of the artifact get. Shapes and descriptors stay out.

import type { EntryChange, PipelineChange, Run, TypeChange, Use } from "../types.ts";

// 2: an entry's `changedAt` became `change`; a pipeline gained `change`, a chain `extrinsicVersions`.
export const SCHEMA_VERSION = 2;

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
      pipelines: report.pipelines.map(({ version, verdict, before, after, expected, live, candidate, retyped, change }) => ({
        version,
        verdict,
        before,
        after,
        expected,
        live,
        candidate,
        retyped,
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
