import type { ChainKey, Selector } from "../types.ts";

/** An SDK source location that accesses a runtime API. */
export interface RuntimeAccess {
  selector: Selector;
  /** Null when the scanner cannot identify the chain. */
  chain: ChainKey | null;
  /** Optional chaining on the pallet or entry. */
  optional: boolean;
  /** The package name, e.g. `@parity/product-sdk-individuality`. */
  package: string;
  /** Relative to the scanned packages directory. */
  file: string;
  line: number;
}
