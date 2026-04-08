import type { Abi } from "viem";
import DotnsRegistry from "../../abis/DotnsRegistry.json" with { type: "json" };
import DotnsContentResolver from "../../abis/DotnsContentResolver.json" with { type: "json" };

export const DOTNS_REGISTRY_ABI = DotnsRegistry.abi as Abi;
export const DOTNS_CONTENT_RESOLVER_ABI = DotnsContentResolver.abi as Abi;
