// A run as JSON for the artifact: a stable shape of its own, so internal types can change
// without changing what readers of the artifact get. Shapes and descriptors stay out.

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

export default function toJson(run: Run) {
  return {
    schemaVersion: SCHEMA_VERSION,
    chains: run.reports.map((report) => ({
      chain: report.chain,
      descriptor: report.descriptor,
      live: report.live,
      candidate: report.candidate,
      entries: report.entries.map(({ requirement, before, after, verdict, changedAt }) => ({
        selector: requirement.selector,
        verdict,
        before,
        after,
        changedAt,
        direction: requirement.direction,
        optional: requirement.optional,
        placedBy: requirement.placedBy,
        uses: requirement.uses.map(({ package: pkg, file, line }) => ({ package: pkg, file, line })),
      })),
      pipelines: report.pipelines.map(({ version, verdict, before, after, expected, live, candidate, retyped }) => ({
        version,
        verdict,
        before,
        after,
        expected,
        live,
        candidate,
        retyped,
      })),
    })),
    unplaced: run.unplaced.map(use),
  };
}
