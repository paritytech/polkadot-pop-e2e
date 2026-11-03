import "./env.js";
import { decodeLink, read, type Descriptor, type Pointer } from "@parity/trinity-stack";
import { NETWORKS, networkConfig, selectNetwork, type NetworkConfig } from "./stack-config.js";

export type { NetworkConfig } from "./stack-config.js";

/**
 * A descriptor URL or a stack link on any scheme or domain, such as `polkadotapp://stack?…` or
 * `https://dot.li/stack?…`, whose `url` query parameter is the descriptor.
 */
function stackPointer(location: string): Pointer {
  try {
    return decodeLink(location);
  } catch {
    return { url: location };
  }
}

/** Fetches and verifies a descriptor; fails on an unreachable or expired stack. */
async function readStack(pointer: Pointer, label: string): Promise<Descriptor> {
  try {
    const accepted = await read(pointer);
    if (accepted.expired) throw new Error(`the stack expired at ${accepted.descriptor.expiresAt}`);
    if (accepted.stale) console.warn(`[networks] ${label}: the descriptor is past its validUntil`);
    return accepted.descriptor;
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
}

// Read once, when this module loads: the stack `STACK` points at, such as a release-gate fork
// at http://127.0.0.1:8090/.well-known/trinity-stack.json, or else the tested network's own.
const stackLocation = process.env.STACK;
const pointer = stackLocation ? stackPointer(stackLocation) : undefined;
const stack = pointer && { pointer, descriptor: await readStack(pointer, `STACK=${stackLocation}`) };
const network = selectNetwork(process.env.NETWORK, stack);
const config = networkConfig(
  NETWORKS[network],
  stack?.descriptor ?? (await readStack(NETWORKS[network].stack, network)),
);

/** The `NETWORKS` entry the run tests, such as `previewnet` for a previewnet fork. */
export function networkKey(): string {
  return network;
}

export function getNetworkConfig(): NetworkConfig {
  return config;
}
