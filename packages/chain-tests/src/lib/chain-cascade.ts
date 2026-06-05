/**
 * Module-level cache of per-chain liveness verdicts populated by the
 * `Chain Health` probe (src/tests/probes/chain-health.test.ts), and
 * read by downstream features via `assertChainHealthy(chain)` in their
 * `beforeAll`.
 *
 * Pattern mirrors `[ring-cascade]` / `[ib-cascade]`: the FIRST symptom
 * carries the diagnostic; subsequent dependent tests fail-fast off a
 * cached marker so an unhealthy chain doesn't burn the whole per-attempt
 * retry budget. Without this, PGAS's 6-min internal timeout + IB setup
 * + tail tests routinely overshoot the workflow's 10-min per-attempt
 * cap when AH or People are degrading — exactly the failure shape
 * observed on `paseo-next-v2` on 2026-06-03.
 *
 * Survives across test files because vitest's `poolOptions=singleFork`
 * keeps module state for one run — same mechanism used by
 * `attested-fixture.ts` to share its IB-cascade marker.
 */

export type ChainName = "people" | "asset-hub" | "bulletin";

const unhealthy: Map<ChainName, string> = new Map();

export function markChainUnhealthy(chain: ChainName, reason: string): void {
  unhealthy.set(chain, reason);
}

export function getChainUnhealthyReason(chain: ChainName): string | undefined {
  return unhealthy.get(chain);
}

export const CHAIN_CASCADE_PREFIX = "[chain-cascade]";

/**
 * Throw a tagged cascade error if the named chain was marked unhealthy
 * by the `Chain Health` probe. Call this at the top of `beforeAll` in
 * any suite that depends on this chain — it fail-fasts in milliseconds
 * instead of hanging on RPC subscriptions against a dead/lagging node.
 */
export function assertChainHealthy(chain: ChainName): void {
  const reason = unhealthy.get(chain);
  if (reason !== undefined) {
    throw new Error(
      `${CHAIN_CASCADE_PREFIX} ${chain} chain failed the Chain Health probe — ` +
        `see "Chain Health" suite for the real signal. Probe verdict: ${reason}`,
    );
  }
}
