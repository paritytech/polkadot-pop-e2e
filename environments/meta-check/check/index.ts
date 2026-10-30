// check(R, A, A'): what upgrading one chain from the live runtime (A) to the candidate
// (A') does to the SDK. Every grade is D against a runtime; A against A' only says
// where an entry changed.

import type { CompatibilityCache } from "@polkadot-api/metadata-compatibility";
import type Runtime from "../runtime/index.ts";
import type { EntryFinding, PipelineFinding, Report, Requirements } from "../types.ts";
import { changedAt, entryLevel, pipelineLevel, verdict } from "./grade.ts";

export default function check(requirements: Requirements, live: Runtime, candidate: Runtime): Report {
  const { descriptor } = requirements;
  // PAPI caches by pair of type nodes; one cache per pair of sides, and a separate one
  // for the change-tracking comparison, whose results carry more.
  const toLive: CompatibilityCache = new Map();
  const toCandidate: CompatibilityCache = new Map();
  const liveToCandidate: CompatibilityCache = new Map();

  const entries = requirements.entries.map((requirement): EntryFinding => {
    const before = entryLevel(requirement, descriptor, live, toLive);
    const after = entryLevel(requirement, descriptor, candidate, toCandidate);
    return {
      requirement,
      before,
      after,
      verdict: verdict(before, after, requirement.optional),
      changedAt: changedAt(requirement.selector, live, candidate, liveToCandidate),
    };
  });

  const versions = [
    ...new Set([descriptor, live, candidate].flatMap((view) => Object.keys(view.pipelines).map(Number))),
  ].sort((a, b) => a - b);
  const pipelines = requirements.signs
    ? versions.map((version): PipelineFinding => {
        const before = pipelineLevel(version, descriptor, live, toLive);
        const after = pipelineLevel(version, descriptor, candidate, toCandidate);
        const expected = descriptor.pipelines[version] ?? null;
        return {
          version,
          expected,
          live: live.pipelines[version] ?? null,
          candidate: candidate.pipelines[version] ?? null,
          before: before.level,
          after: after.level,
          // A version D does not have is one the SDK never signs with.
          verdict: expected ? verdict(before.level, after.level) : "ok",
          retyped: after.retyped,
        };
      })
    : [];

  return {
    chain: requirements.chain,
    descriptor: { chain: descriptor.chain, codeHash: descriptor.codeHash },
    live: live.version,
    candidate: candidate.version,
    entries,
    pipelines,
  };
}
