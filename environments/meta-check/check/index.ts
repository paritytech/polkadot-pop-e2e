// check(R, A): how well one runtime, live (A) or the candidate (A'), fits what the SDK
// needs from its chain. Every grade is D against that runtime. Comparing the two checks
// is regression's job; comparing the two runtimes is diff's.

import type { CompatibilityCache } from "@polkadot-api/metadata-compatibility";
import type Runtime from "../runtime/index.ts";
import type { EntryCheck, PipelineCheck, Requirements, RuntimeCheck } from "../types.ts";
import { entryLevel, pipelineLevel } from "./grade.ts";

export default function check(requirements: Requirements, runtime: Runtime): RuntimeCheck {
  const { descriptor } = requirements;
  // PAPI caches by pair of type nodes: one cache serves every grade of D against this runtime.
  const cache: CompatibilityCache = new Map();

  const entries = requirements.entries.map(
    (requirement): EntryCheck => ({ requirement, level: entryLevel(requirement, descriptor, runtime, cache) }),
  );

  const versions = [
    ...new Set([descriptor, runtime].flatMap((view) => Object.keys(view.pipelines).map(Number))),
  ].sort((a, b) => a - b);
  const pipelines = requirements.usesTransactions
    ? versions.map((version): PipelineCheck => {
        const { level, retyped } = pipelineLevel(version, descriptor, runtime, cache);
        return {
          version,
          expected: descriptor.pipelines[version] ?? null,
          actual: runtime.pipelines[version] ?? null,
          level,
          retyped,
        };
      })
    : [];

  return {
    chain: requirements.chain,
    descriptor: { chain: descriptor.chain, codeHash: descriptor.codeHash },
    runtime: runtime.version,
    entries,
    pipelines,
  };
}
