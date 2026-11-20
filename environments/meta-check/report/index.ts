// Join one chain's compatibility verdicts and runtime changes for both report formats.

import type { RuntimeCheck } from "../check/types.ts";
import type { RuntimeDiff } from "../diff/types.ts";
import regression from "../regression/index.ts";
import type { PipelineVerdict } from "../regression/types.ts";
import type { PipelineFinding, Report } from "./types.ts";

/** The report from its parts: the same requirements checked against live and the candidate, and the diff between them. */
export function assembleReport(onLive: RuntimeCheck, onCandidate: RuntimeCheck, changes: RuntimeDiff): Report {
  const verdicts = regression(onLive, onCandidate);
  // A change with no finding to go on would vanish from the report.
  const selectors = new Set(verdicts.entries.map((entry) => entry.requirement.selector));
  const versions = new Set(verdicts.pipelines.map((pipeline) => pipeline.version));
  if (
    changes.chain !== onLive.chain ||
    changes.entries.some((change) => !selectors.has(change.selector)) ||
    changes.pipelines.some((change) => !versions.has(change.version))
  ) {
    throw new Error("the diff is not of the requirements and chain the checks are");
  }
  const entryChange = new Map(changes.entries.map((change) => [change.selector, change]));
  const pipelineChange = new Map(changes.pipelines.map((change) => [change.version, change]));

  /** A pipeline's verdict, with D's list, each runtime's list, what the candidate retyped, and what changed. */
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
      retypedFromSdk: candidatePipeline?.retyped ?? [],
      change: pipelineChange.get(version) ?? null,
    };
  };

  return {
    chain: onLive.chain,
    descriptor: onLive.descriptor,
    live: onLive.runtime,
    candidate: onCandidate.runtime,
    entries: verdicts.entries.map((entry) => ({ ...entry, change: entryChange.get(entry.requirement.selector) ?? null })),
    pipelines: verdicts.pipelines.map(pipelineFinding),
    extrinsicVersions: changes.extrinsicVersions,
  };
}
