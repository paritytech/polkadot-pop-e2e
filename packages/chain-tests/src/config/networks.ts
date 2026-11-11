import "./env.js";
import { decodeLink, isTrinityStackError, read, type Descriptor, type Pointer } from "@parity/trinity-stack";
import { NETWORKS, buildNetworkConfig, selectNetwork, type NetworkConfig } from "./stack-config.js";

export type { NetworkConfig } from "./stack-config.js";

/**
 * The pointer a `STACK` value stands for: a stack link on any scheme or domain, such as
 * `polkadotapp://stack?…` or `https://dot.li/stack?…`, or a descriptor URL. A known network's
 * descriptor URL gets that network's key, so it is verified the same way as without `STACK`.
 */
function parseStackPointer(location: string): Pointer {
  try {
    return decodeLink(location);
  } catch (error) {
    if (!isTrinityStackError(error) || error.code !== "invalid-link") throw error;
    return Object.values(NETWORKS).find((entry) => entry.stack.url === location)?.stack ?? { url: location };
  }
}

/** Fetches and verifies a descriptor; fails on an unreachable or expired stack. */
async function readStack(pointer: Pointer, label: string): Promise<Descriptor> {
  try {
    const result = await read(pointer);
    if (result.expired) throw new Error(`the stack expired at ${result.descriptor.expiresAt}`);
    if (result.stale) console.warn(`[networks] ${label}: the descriptor is past its validUntil`);
    return result.descriptor;
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
}

// Read once, when this module loads: the stack `STACK` points at, such as a release-gate fork
// at http://127.0.0.1:8090/.well-known/trinity-stack.json, or else the tested network's own.
const stackLocation = process.env.STACK;
const pointer = stackLocation ? parseStackPointer(stackLocation) : undefined;
const stack = pointer && { pointer, descriptor: await readStack(pointer, `STACK=${stackLocation}`) };
const network = selectNetwork(process.env.NETWORK, stack);
const config = buildNetworkConfig(
  NETWORKS[network],
  stack?.descriptor ?? (await readStack(NETWORKS[network].stack, network)),
);

/** The `NETWORKS` entry the run tests, such as `previewnet` for a previewnet fork. */
export function networkKey(): string {
  return network;
}

/** The `STACK` value the run tests, or undefined when it tests the network's own stack. */
export function stackOverride(): string | undefined {
  return stackLocation;
}

export function getNetworkConfig(): NetworkConfig {
  return config;
}
