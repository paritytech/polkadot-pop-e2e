import "./env.js";
import { decodeLink, read, type Descriptor, type Pointer } from "@parity/trinity-stack";
import { NETWORKS, networkConfig, selectNetwork, type NetworkConfig } from "./stack-config.js";

export type { NetworkConfig, NetworkFeatures } from "./stack-config.js";

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
async function readStack(pointer: Pointer, origin: string): Promise<Descriptor> {
  try {
    const accepted = await read(pointer);
    if (accepted.expired) throw new Error(`the stack expired at ${accepted.descriptor.expiresAt}`);
    if (accepted.stale) console.warn(`[networks] ${origin}: the descriptor is past its validUntil`);
    return accepted.descriptor;
  } catch (error) {
    throw new Error(`${origin}: ${(error as Error).message}`);
  }
}

// Read once, when this module loads: the stack `STACK` points at, such as a release-gate fork
// at http://127.0.0.1:8090/.well-known/trinity-stack.json, or else the tested network's own.
const stackLocation = process.env.STACK;
const overridePointer = stackLocation ? stackPointer(stackLocation) : undefined;
const stackOverride = overridePointer && {
  pointer: overridePointer,
  descriptor: await readStack(overridePointer, `STACK=${stackLocation}`),
};
const network = selectNetwork(process.env.NETWORK, stackOverride);
const descriptor = stackOverride?.descriptor ?? (await readStack(NETWORKS[network].stack, network));
const config = networkConfig(NETWORKS[network], descriptor);

/** The `NETWORKS` entry the run tests, such as `previewnet` for a previewnet fork. */
export function networkKey(): string {
  return network;
}

export function getNetworkConfig(): NetworkConfig {
  return config;
}
