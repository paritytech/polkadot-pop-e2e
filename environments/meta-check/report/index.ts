// One chain's report, as the markdown and the JSON show it: the requirements checked
// against live (A) and the candidate (A'), the verdict on each, and where entries changed.
// Built here; json.ts and markdown.ts render it.

import check from "../check/index.ts";
import diff from "../diff/index.ts";
import regression from "../regression/index.ts";
import type Runtime from "../runtime/index.ts";
import type { PipelineFinding, PipelineVerdict, Report, Requirements, RuntimeCheck, RuntimeDiff } from "../types.ts";

export default function buildReport(requirements: Requirements, live: Runtime, candidate: Runtime): Report {
  return assembleReport(check(requirements, live), check(requirements, candidate), diff(requirements, live, candidate));
}

/** The report from its parts: the same requirements checked against live and the candidate, and the diff between them. */
export function assembleReport(onLive: RuntimeCheck, onCandidate: RuntimeCheck, changes: RuntimeDiff): Report {
  const verdicts = regression(onLive, onCandidate);
  const changedAt = new Map(changes.entries.map((change) => [change.selector, change.changedAt]));

  /** A pipeline's verdict, with D's list, each runtime's list, and what the candidate retyped. */
  const pipelineFinding = ({ version, before, after, verdict }: PipelineVerdict): PipelineFinding => {
    const livePipeline = onLive.pipelines.find((pipeline) => pipeline.version === version);
    const candidatePipeline = onCandidate.pipelines.find((pipeline) => pipeline.version === version);
    return {
      version,
      // Both checks graded the same D, so either one has D's list.
      expected: (livePipeline ?? candidatePipeline)?.expected ?? null,
      live: livePipeline?.actual ?? null,
      candidate: candidatePipeline?.actual ?? null,
      before,
      after,
      verdict,
      retyped: candidatePipeline?.retyped ?? [],
    };
  };

  return {
    chain: onLive.chain,
    descriptor: onLive.descriptor,
    live: onLive.runtime,
    candidate: onCandidate.runtime,
    entries: verdicts.entries.map((entry) => ({ ...entry, changedAt: changedAt.get(entry.requirement.selector) ?? [] })),
    pipelines: verdicts.pipelines.map(pipelineFinding),
  };
}
