// regression(onLive, onCandidate): what upgrading a chain from live (A) to the candidate
// (A') does to the SDK, from the same requirements checked against each. It compares
// levels only; where the runtime's types changed is diff's.

import { RANK } from "../level.ts";
import type { Level, RuntimeCheck } from "../types.ts";
import type { EntryVerdict, PipelineVerdict, Regression, Verdict } from "./types.ts";

/**
 * The Partial policy: the candidate breaks an entry when it fits worse than live did
 * and below BackwardsCompatible. An entry that already did not fit on live is
 * pre-existing: this upgrade did not cause it. An optional entry may be missing.
 */
export function verdict(before: Level, after: Level, optional = false): Verdict {
  if (optional && after === "Missing") return "ok";
  if (RANK[after] >= RANK.BackwardsCompatible) return "ok";
  return RANK[after] < RANK[before] ? "breaking" : "pre-existing";
}

const mismatch = () => new Error("live and the candidate were checked against different requirements");

/** `onLive`: R checked against live. `onCandidate`: the same R checked against the candidate. */
export default function regression(onLive: RuntimeCheck, onCandidate: RuntimeCheck): Regression {
  if (onLive.chain !== onCandidate.chain || onLive.entries.length !== onCandidate.entries.length) throw mismatch();
  const entries = onLive.entries.map(({ requirement, level: before }, index): EntryVerdict => {
    const candidateEntry = onCandidate.entries[index];
    if (candidateEntry?.requirement.selector !== requirement.selector) throw mismatch();
    const after = candidateEntry.level;
    return { requirement, before, after, verdict: verdict(before, after, requirement.optional) };
  });

  const versions = [...new Set([...onLive.pipelines, ...onCandidate.pipelines].map((pipeline) => pipeline.version))];
  const pipelines = versions
    .sort((a, b) => a - b)
    .map((version): PipelineVerdict => {
      const livePipeline = onLive.pipelines.find((pipeline) => pipeline.version === version);
      const candidatePipeline = onCandidate.pipelines.find((pipeline) => pipeline.version === version);
      // check grades every version D or its own runtime has, so a version one check lacks
      // is on neither: Missing there, as pipelineLevel grades it.
      const before = livePipeline?.level ?? "Missing";
      const after = candidatePipeline?.level ?? "Missing";
      // A version D does not have is one the SDK never signs with: nothing to break.
      const signed = [livePipeline, candidatePipeline].some((pipeline) => pipeline?.expected);
      return { version, before, after, verdict: signed ? verdict(before, after) : "ok" };
    });

  return { entries, pipelines };
}
