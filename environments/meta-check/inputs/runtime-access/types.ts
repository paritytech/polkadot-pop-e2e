import type { ChainKey, Selector } from "../../model/types.ts";

/** An SDK source location that accesses a runtime API. */
export interface RuntimeAccess {
  selector: Selector;
  /** Null when the scanner cannot identify the chain. */
  chain: ChainKey | null;
  /** Optional chaining on the pallet or entry. */
  optional: boolean;
  /** Relative to the scan root; package-prefixed when scanning multiple roots. */
  file: string;
  line: number;
}
