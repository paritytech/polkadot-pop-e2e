// The breaking changes in one runtime diff, for the Matrix alert. Same rule as the job
// summary's `isBreaking` (markdown.ts), with no junit, so a failing test cannot change it.
// summary.test.ts keeps the two in step.

import type { Diff } from "./diff.ts";

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
    const entries = chain.entries.filter((e) => e.severity === "breaking").length;
    // A removed entry is already counted above under its own name.
    const gone = chain.missingSurfaces.filter(
      (m) => !m.alsoMissingOnLive && !chain.entries.some((e) => e.change === "removed" && e.selector === m.selector),
    ).length;
    // The SDK only signs on chains with a descriptor.
    const signs = chain.descriptor !== null;
    const versions = signs ? chain.extensions.versions.filter((v) => v.breaking).length : 0;
    const extrinsic = signs ? chain.extensions.extrinsicVersions.removed.length : 0;
    return { chain: chain.chain, breaking: entries + gone + versions + extrinsic };
  });
  const sdkUnreadable = diff.sdkError !== null;
  return {
    breaking: chains.reduce((total, c) => total + c.breaking, 0),
    chains,
    sdkError: diff.sdkError,
    unknown: chains.filter((c) => sdkUnreadable || c.error !== undefined).length,
  };
}
