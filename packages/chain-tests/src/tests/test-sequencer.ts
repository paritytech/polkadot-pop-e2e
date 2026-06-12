/**
 * Deterministic test-file sequencer for the chain-tests suite.
 *
 * Vitest's default `BaseSequencer` re-orders files run-to-run: it
 * prioritises files that failed in the previous run, then sorts by
 * duration descending. That heuristic optimises for fail-fast feedback
 * in CI/dev, but it breaks our suite because we rely on a STRICT order:
 *
 *   1) `chain-health` — first signal a chain is alive
 *   2) `ring-health`  — first signal the ring builder is alive
 *   3) `ib-health`    — registers the fresh attested account
 *   4) `ring-inclusion` — waits for THAT account to be in the ring,
 *                        caches the `MemberLocation` for downstream
 *   5) feature suites (core, allowances, dotns, statement, storage)
 *      — read the cached account + ring location instead of paying
 *      the multi-minute IB-poll + inclusion wait themselves
 *
 * Without this ordering the feature suites either re-do work the
 * probes already did, or — worse — fail with "no cached ring location"
 * because they ran before the probe.
 *
 * Files not in the explicit order list still run (they fall through
 * to alphabetical tail-sort), so adding a new test file doesn't break
 * the suite — it just runs after everything listed here.
 */

import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

const ORDER = [
  "probes/chain-health.test.ts",
  "probes/ring-health.test.ts",
  "probes/ib-health.test.ts",
  "probes/ring-inclusion.test.ts",
  "core.test.ts",
  "allowances.test.ts",
  "alias-claim.test.ts",
  "pop-gate.test.ts",
  "dotns.test.ts",
  "statement.test.ts",
  "storage.test.ts",
];

function priority(path: string): number {
  for (let i = 0; i < ORDER.length; i++) {
    if (path.endsWith(ORDER[i]!)) return i;
  }
  // Unlisted files sort after listed ones, alphabetically among themselves.
  return ORDER.length;
}

export default class OrderedSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => {
      const dp = priority(a.moduleId) - priority(b.moduleId);
      return dp !== 0 ? dp : a.moduleId.localeCompare(b.moduleId);
    });
  }
}
