// diff(R, A, A'): where the entries the SDK uses changed between live (A) and the
// candidate (A'). It says what changed, not whether the SDK minds: that is check's
// and regression's.

import { entryPointsAreCompatible, type CompatibilityCache } from "@polkadot-api/metadata-compatibility";
import type Runtime from "../runtime/index.ts";
import type { EntryChange, Requirements, RuntimeDiff, Selector } from "../types.ts";

// PAPI reports a change at every level of the type tree it passes through; the deepest
// ones say where. Past this many, the list stops helping.
const MAX_CHANGED_PATHS = 8;

/** Where the entry's type differs between live and candidate: `args.dest`, `value.data.free`. */
function changedAt(selector: Selector, live: Runtime, candidate: Runtime, cache: CompatibilityCache): string[] {
  const before = live.entry(selector);
  const after = candidate.entry(selector);
  if (!before || !after) return [];
  //using PAPI’s comparison engine to obtain change paths, not to decide SDK compatibility
  const result = entryPointsAreCompatible(
    before.shape,
    (id) => live.node(id),
    after.shape,
    (id) => candidate.node(id),
    cache,
    true,
  );
  const paths = [
    ...result.args.changes.map((change) => (change.path ? `args.${change.path}` : "args")),
    ...result.values.changes.map((change) => (change.path ? `value.${change.path}` : "value")),
  ];
  return paths.filter((path) => !paths.some((other) => other.startsWith(`${path}.`))).slice(0, MAX_CHANGED_PATHS);
}

export default function diff(requirements: Requirements, live: Runtime, candidate: Runtime): RuntimeDiff {
  // Tracking changes makes PAPI's results carry more, so this cache is not shared with a check's.
  const cache: CompatibilityCache = new Map();
  const entries = requirements.entries.flatMap(({ selector }): EntryChange[] => {
    const paths = changedAt(selector, live, candidate, cache);
    return paths.length > 0 ? [{ selector, changedAt: paths }] : [];
  });
  return { chain: requirements.chain, entries };
}
