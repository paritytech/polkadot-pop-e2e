// R: what the SDK needs from each chain, 
// - > joining what its code reads (U) with what its & 
// descriptors expect (D).
//
// A read that names its chain (`chain.individuality...`) belongs to that chain. One that
// does not (`api.tx.Coinage.transfer`) belongs to every chain whose descriptor has the
// pallet: `Coinage` only exists on People, while `System` lands on every chain.

import type SdkDescriptor from "../descriptor/index.ts";
import { CHAIN_KEYS, DIRECTION, parseSelector } from "../selector.ts";
import type { ChainKey, Selector } from "../types.ts";
import type RuntimeAccesses from "../runtime-access/index.ts";
import type { RuntimeAccess } from "../runtime-access/types.ts";
import type { Requirement, RequirementSet } from "./types.ts";

/** The accesses placed on one chain, per selector, and whether any named the chain. */
type Placed = Map<Selector, { accesses: RuntimeAccess[]; namedChain: boolean }>;

/**
 * `descriptors` maps each chain-client key to the descriptor for the network being
 * checked, e.g. `{ individuality: paseo-individuality, assetHub: paseo-asset-hub }`.
 * Only those chains get requirements.
 */
export default function buildRequirements(
  descriptors: Partial<Record<ChainKey, SdkDescriptor>>,
  runtimeAccesses: RuntimeAccesses,
): RequirementSet {
  const placed = new Map<ChainKey, Placed>();
  const unplaced: RuntimeAccess[] = [];
  const place = (chain: ChainKey, access: RuntimeAccess) => {
    const bySelector: Placed = placed.get(chain) ?? new Map();
    const entry = bySelector.get(access.selector) ?? { accesses: [], namedChain: false };
    entry.accesses.push(access);
    entry.namedChain ||= access.chain === chain;
    bySelector.set(access.selector, entry);
    placed.set(chain, bySelector);
  };

  for (const access of runtimeAccesses.accesses) {
    const { kind, group } = parseSelector(access.selector);
    const chains = access.chain !== null ? [access.chain] : CHAIN_KEYS.filter((key) => descriptors[key]?.hasGroup(kind, group));
    const targets = chains.filter((chain) => descriptors[chain] !== undefined);
    if (targets.length === 0) unplaced.push(access);
    for (const chain of targets) place(chain, access);
  }

  const chains = CHAIN_KEYS.flatMap((chain) => {
    const descriptor = descriptors[chain];
    if (!descriptor) return [];
    const entries = [...(placed.get(chain) ?? [])]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([selector, { accesses, namedChain }]): Requirement => ({
          selector,
          get direction() {
            return DIRECTION[parseSelector(this.selector).kind];
          },
          expected: descriptor.entry(selector) ?? null,
          accesses,
          placedBy: namedChain ? "chain" : "pallet",
          get optional() {
            return this.accesses.every((access) => access.optional);
          },
        }),
      );
    return [
      {
        chain,
        descriptor,
        entries,
        get usesTransactions() {
          return this.entries.some(({ selector }) => parseSelector(selector).kind === "tx");
        },
      },
    ];
  });

  return { chains, unplaced };
}
