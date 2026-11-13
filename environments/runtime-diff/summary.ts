// The breaking changes in one runtime diff, counted for the workflow's Matrix alert. It
// follows the job summary's rule (markdown.ts `isBreaking`): breaking entries, gone SDK
// surfaces, and removed transaction-extension versions. Extension versions are only
// counted on a chain the SDK signs for. It reads no junit, so a failing test cannot
// change the count.

import type { Diff } from "./diff.ts";

export interface ChainSummary {
  chain: string;
  breaking: number;
  /** Set when the chain could not be diffed. Its entries were never checked. */
  error?: string;
}

export interface Summary {
  breaking: number;
  chains: ChainSummary[];
  /**
   * Why the installed SDK could not be read. Then no chain's entries were graded, so
   * every chain is unknown, not only the ones that errored.
   */
  sdkError: string | null;
  /** Chains whose breaking changes are not known: each one counted once. */
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
    // The SDK only signs on chains it has a descriptor for.
    const signs = chain.descriptor !== null;
    const versions = signs ? chain.extensions.versions.filter((v) => v.breaking).length : 0;
    const extrinsicVersions = signs ? chain.extensions.extrinsicVersions.removed.length : 0;
    return { chain: chain.chain, breaking: entries + gone + versions + extrinsicVersions };
  });
  const sdkUnreadable = diff.sdkError !== null;
  return {
    breaking: chains.reduce((total, c) => total + c.breaking, 0),
    chains,
    sdkError: diff.sdkError,
    unknown: chains.filter((c) => sdkUnreadable || c.error !== undefined).length,
  };
}
