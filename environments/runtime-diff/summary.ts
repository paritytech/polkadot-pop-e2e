// The breaking changes in one runtime diff, for the Matrix alert. Counts what the job
// summary's `breakingOf` (markdown.ts) finds, with no junit, so a failing test cannot change it.

import type { Diff } from "./diff.ts";
import { breakingOf } from "./markdown.ts";

export interface ChainSummary {
  chain: string;
  breaking: number;
  /** Set when the chain could not be diffed, so its entries were never checked. */
  error?: string;
}

export interface Summary {
  breaking: number;
  chains: ChainSummary[];
  /** Why the SDK could not be read. Then no chain was graded, so every chain is unknown. */
  sdkError: string | null;
  /** Chains whose breaking changes are unknown, each counted once. */
  unknown: number;
}

export function summarize(diff: Diff): Summary {
  const chains = diff.chains.map((chain): ChainSummary => {
    if ("error" in chain) return { chain: chain.chain, breaking: 0, error: chain.error };
    // No failing-test names here, so only the diff decides.
    const b = breakingOf(chain);
    return { chain: chain.chain, breaking: b.entries.length + b.missing.length + b.extensions };
  });
  const sdkUnreadable = diff.sdkError !== null;
  return {
    breaking: chains.reduce((total, c) => total + c.breaking, 0),
    chains,
    sdkError: diff.sdkError,
    unknown: chains.filter((c) => sdkUnreadable || c.error !== undefined).length,
  };
}
