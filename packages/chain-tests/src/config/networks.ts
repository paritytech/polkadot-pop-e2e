import { decodeLink, read, type Descriptor } from "@parity/trinity-stack";

/** Per-network capability flags — drives test gating. */
export interface NetworkFeatures {
  /** `pallet-resources` allowance flow (StmtStore + LongTermStorage claims). */
  resources: boolean;
  /** `pallet-pgas` claim + `pallet-revive` PGAS-paid contract calls. */
  pgas: boolean;
  /**
   * Bulletin collator exposes the `hop_*` RPCs (HOP submit/claim/ack/poolStatus)
   * AND the runtime has `pallet-bulletin-hop-promotion` wired in. Both are
   * required: missing the pallet means `is_promoted_on_chain` is unavailable;
   * missing `--enable-hop` on the collator means `hop_submit` returns nothing.
   * Check with `hop_poolStatus` over WS before flipping this on.
   */
  hop: boolean;
  /** DotNS is deployed at the addresses product-sdk pins. */
  dotns: boolean;
}

export interface NetworkConfig {
  name: string;
  assetHub: { ws: string };
  people: { ws: string };
  bulletin: {
    ws: string;
    /**
     * Optional dedicated HOP collator endpoint — a Bulletin collator run
     * with `--enable-hop`. The hop test points its `HopClient` here when
     * set, falling back to `ws` otherwise. Lets HOP target a specific
     * collator distinct from the public Bulletin RPC (which may be a plain
     * full node that doesn't serve the `hop_*` RPCs).
     */
    hopWs?: string;
  };
  identityBackend: string | null;
  /** "challenge" marks an IBv2 (identity-backend-rust) backend; absent means IBv1. */
  identityBackendAuth?: "challenge";
  ipfsGateway: string;
  features: NetworkFeatures;
  // Optional URI override for the keyring. When set, used instead of
  // the `TEST_MNEMONIC` env. Used on local forks, where `//Alice` is funded.
  testAccountUri?: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  // paseo-next v1 is sunset — no more testing against it. The runtime
  // doesn't ship the rich AssetHub (`MembersSubscriber`, pallet-pgas,
  // pallet-revive) we depend on, and product flows have all migrated to
  // paseo-next-v2 anyway. v2 + previewnet are the supported targets.
  "paseo-next-v2": {
    name: "Paseo Next v2",
    // Paseo Asset Hub Next (1500), Bulletin Next (1501), People Next System
    // (1502). Same runtime feature set as previewnet — pallet-resources +
    // pallet-pgas + pallet-revive — but with the public Polkadot endpoints.
    assetHub: { ws: "wss://paseo-asset-hub-next-rpc.polkadot.io" },
    people: { ws: "wss://paseo-people-next-system-rpc.polkadot.io" },
    bulletin: {
      ws: "wss://paseo-bulletin-next-rpc.polkadot.io",
      hopWs: "wss://paseo-hop-next-0.polkadot.io",
    },
    // device-uniqueness-backend (the new IB) — challenge→token auth.
    identityBackend: "https://identity.dotspark.app",
    identityBackendAuth: "challenge",
    ipfsGateway: "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs",
    features: { resources: true, pgas: true, hop: true, dotns: true },
  },
  previewnet: {
    name: "Previewnet",
    assetHub: { ws: "wss://previewnet.substrate.dev/asset-hub" },
    people: { ws: "wss://previewnet.substrate.dev/people" },
    bulletin: { ws: "wss://previewnet.substrate.dev/bulletin" },
    // device-uniqueness-backend (the new IB) — challenge→token auth.
    identityBackend: "https://previewnet.substrate.dev/dub",
    identityBackendAuth: "challenge",
    ipfsGateway: "https://previewnet.substrate.dev/ipfs",
    features: { resources: true, pgas: true, hop: true, dotns: true },
  },
  // The community-operated Polkadot Products Devnet: the REAL Paseo system chains
  // (Asset Hub 1000, People 1004) plus Bulletin 1010 on the public relay —
  // https://docs.polkadotcommunity.foundation/reference/networks/. None of the
  // next-runtime features exist here (no pallet-resources/pgas, no HOP, no
  // identity backend), so only the chain-level health portion of the suite runs.
  // Exists primarily as a release-gate base network (a fork of devnet).
  devnet: {
    name: "Polkadot Products Devnet",
    assetHub: { ws: "wss://asset-hub-paseo-rpc.n.dwellir.com" },
    people: { ws: "wss://people-paseo.rotko.net" },
    bulletin: { ws: "wss://bulletin-paseo.tservices.es:8443" },
    identityBackend: null,
    ipfsGateway: "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs",
    features: { resources: false, pgas: false, hop: false, dotns: false },
  },
};

/**
 * The stack `STACK` points at, by its descriptor URL or a `polkadotapp://stack` link, read
 * once when this module loads. A release-gate fork serves its own at
 * http://127.0.0.1:8090/.well-known/trinity-stack.json.
 */
const stack = process.env.STACK ? await readStack(process.env.STACK) : undefined;

async function readStack(location: string): Promise<Descriptor> {
  const pointer = location.startsWith("polkadotapp:") ? decodeLink(location) : { url: location };
  try {
    return (await read(pointer)).descriptor;
  } catch (error) {
    throw new Error(`STACK=${location}: ${(error as Error).message}`);
  }
}

/**
 * The `NETWORKS` entry the run tests: `NETWORK`, else the network `STACK` is an instance or a
 * fork of (the engine names a fork of `previewnet` `previewnet-fork`), else paseo-next-v2.
 */
export function networkKey(): string {
  return process.env.NETWORK ?? stack?.id.replace(/-fork$/, "") ?? "paseo-next-v2";
}

/**
 * A known network's capability flags with the stack's transport: its chains, its HOP
 * endpoint, its identity backend (none when the stack runs none, and attestation-dependent
 * tests then skip) and its IPFS gateway. On a fork `//Alice` is the test account: sudo by
 * bite override, and fundable on every fork.
 */
function stackConfig(descriptor: Descriptor, base: NetworkConfig): NetworkConfig {
  const rpc = (role: string) => {
    const url = descriptor.chains.find((chain) => chain.role === role)?.rpc[0];
    if (!url) throw new Error(`stack ${descriptor.id} has no ${role} chain`);
    return url;
  };
  const service = (kind: string) =>
    descriptor.services.find((entry) => entry.kind === kind)?.urls[0]?.replace(/\/$/, "");
  const identityBackend = service("dub") ?? null;
  const hopWs = service("hop");
  const ipfsGateway = service("ipfs-gateway");
  if (!ipfsGateway) throw new Error(`stack ${descriptor.id} has no ipfs-gateway service`);
  return {
    ...base,
    name: descriptor.name,
    assetHub: { ws: rpc("AssetHub") },
    people: { ws: rpc("People") },
    bulletin: { ws: rpc("Bulletin"), ...(hopWs && { hopWs }) },
    identityBackend,
    identityBackendAuth: identityBackend ? "challenge" : undefined,
    ipfsGateway,
    ...(descriptor.id.endsWith("-fork") && { testAccountUri: "//Alice" }),
  };
}

export function getNetworkConfig(): NetworkConfig {
  const name = networkKey();
  const config = NETWORKS[name];
  if (!config) {
    throw new Error(`Unknown network: ${name}. Available: ${Object.keys(NETWORKS).join(", ")}`);
  }
  return stack ? stackConfig(stack, config) : config;
}
