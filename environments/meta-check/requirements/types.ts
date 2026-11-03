import type SdkDescriptor from "../descriptor/index.ts";
import type { ChainKey, Direction, Entry, Selector } from "../types.ts";
import type { RuntimeAccess } from "../runtime-access/types.ts";

/** An SDK requirement for one metadata entry on one chain. */
export interface Requirement {
  selector: Selector;
  get direction(): Direction;
  /** Expected entry from D; null means only existence is checked. */
  expected: Entry | null;
  accesses: RuntimeAccess[];
  /** Explicit chain access, or inferred from the descriptor's pallet/runtime API. */
  placedBy: "chain" | "pallet";
  /** All accesses are optional; a missing entry is allowed. */
  get optional(): boolean;
}

/** SDK requirements for one chain. */
export interface Requirements {
  chain: ChainKey;
  /** Descriptor used to resolve expected types. */
  descriptor: SdkDescriptor;
  /** Sorted by selector. */
  entries: Requirement[];
  /** Has a tx requirement; enables pipeline checks and extrinsic-version diffing. */
  get usesTransactions(): boolean;
}

/** R: the requirements for each chain the caller gave a descriptor for. */
export interface RequirementSet {
  chains: Requirements[];
  /** Accesses no chain took: their chain has no descriptor, or no descriptor has their pallet. */
  unplaced: RuntimeAccess[];
}
