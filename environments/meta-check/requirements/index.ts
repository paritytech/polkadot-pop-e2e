// R: what the SDK needs from each chain, 
// - > joining what its code reads (U) with what its & 
// descriptors expect (D).
//
// A read that names its chain (`chain.individuality...`) belongs to that chain. One that
// does not (`api.tx.Coinage.transfer`) belongs to every chain whose descriptor has the
// pallet: `Coinage` only exists on People, while `System` lands on every chain.

import type SdkDescriptor from "../descriptor/index.ts";
import { CHAIN_KEYS, DIRECTION, parseSelector } from "../selector.ts";
import type { ChainKey, Requirement, RequirementSet, Selector, Use } from "../types.ts";
import type SdkUsage from "../usage/index.ts";

/** The uses placed on one chain, per selector, and whether any of them named the chain. */
type Placed = Map<Selector, { uses: Use[]; namedChain: boolean }>;

/**
 * `descriptors` maps each chain-client key to the descriptor for the network being
 * checked, e.g. `{ individuality: paseo-individuality, assetHub: paseo-asset-hub }`.
 * Only those chains get requirements.
 */
export default function buildRequirements(
  descriptors: Partial<Record<ChainKey, SdkDescriptor>>,
  usage: SdkUsage,
): RequirementSet {
  const placed = new Map<ChainKey, Placed>();
  const unplaced: Use[] = [];
  const place = (chain: ChainKey, use: Use) => {
    const bySelector: Placed = placed.get(chain) ?? new Map();
    const entry = bySelector.get(use.selector) ?? { uses: [], namedChain: false };
    entry.uses.push(use);
    entry.namedChain ||= use.chain === chain;
    bySelector.set(use.selector, entry);
    placed.set(chain, bySelector);
  };

  for (const use of usage.uses) {
    const { kind, group } = parseSelector(use.selector);
    const chains = use.chain !== null ? [use.chain] : CHAIN_KEYS.filter((key) => descriptors[key]?.hasGroup(kind, group));
    const targets = chains.filter((chain) => descriptors[chain] !== undefined);
    if (targets.length === 0) unplaced.push(use);
    for (const chain of targets) place(chain, use);
  }

  const chains = CHAIN_KEYS.flatMap((chain) => {
    const descriptor = descriptors[chain];
    if (!descriptor) return [];
    const entries = [...(placed.get(chain) ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([selector, { uses, namedChain }]): Requirement => ({
          selector,
          direction: DIRECTION[parseSelector(selector).kind],
          expected: descriptor.entry(selector) ?? null,
          uses,
          placedBy: namedChain ? "chain" : "pallet",
          optional: uses.every((use) => use.optional),
        }),
      );
    const signs = entries.some((entry) => parseSelector(entry.selector).kind === "tx");
    return [{ chain, descriptor, entries, signs }];
  });

  return { chains, unplaced };
}
