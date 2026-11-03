import type { Descriptor, Pointer } from "@parity/trinity-stack";
import { chain } from "@parity/trinity-stack/reader";

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
  /**
   * Attestation through the stack's identity backend. Needs a truapi-host CLI preset for the
   * network, which previewnet and paseo-next-v2 have.
   */
  identity: boolean;
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

/** A network the suite knows: where its operator publishes its descriptor, and what it runs. */
export interface KnownNetwork {
  stack: Pointer;
  features: NetworkFeatures;
}

export const NETWORKS: Record<string, KnownNetwork> = {
  // paseo-next v1 is sunset — no more testing against it. The runtime
  // doesn't ship the rich AssetHub (`MembersSubscriber`, pallet-pgas,
  // pallet-revive) we depend on, and product flows have all migrated to
  // paseo-next-v2 anyway. v2 + previewnet are the supported targets.
  // Paseo Asset Hub Next (1500), Bulletin Next (1501), People Next System (1502).
  "paseo-next-v2": {
    stack: {
      url: "https://stack-paseo-next.parity-testnet.parity.io/.well-known/trinity-stack.json",
      key: "0x2b89d8ca74aa2e11ab55f5af1168cd6929b88d1998aecd979b42cfc1078d5377",
    },
    features: { resources: true, pgas: true, hop: true, dotns: true, identity: true },
  },
  previewnet: {
    stack: {
      url: "https://previewnet.substrate.dev/.well-known/trinity-stack.json",
      key: "0x4d43362f03d5511632a210632d1fb7760b5a663580f12ffca34619f79357e239",
    },
    features: { resources: true, pgas: true, hop: true, dotns: true, identity: true },
  },
  // The community-operated Polkadot Products Devnet: the REAL Paseo system chains
  // (Asset Hub 1000, People 1004) plus Bulletin 1010 on the public relay —
  // https://docs.polkadotcommunity.foundation/reference/networks/. None of the
  // next-runtime features exist here, and truapi-host has no preset for it, so only the
  // chain-level health portion of the suite runs. Exists primarily as a network the
  // release gate forks.
  devnet: {
    stack: {
      url: "https://stack.api.polkadotcommunity.foundation/.well-known/trinity-stack.json",
      key: "0x1fbc5eed0deb09fe4eeefdf45350b4b4cf36370d9bbb93ca2818b076737a0ed3",
    },
    features: { resources: false, pgas: false, hop: false, dotns: false, identity: false },
  },
};

export const DEFAULT_NETWORK = "paseo-next-v2";

/**
 * The `NETWORKS` entry a stack is an instance or a fork of: the one publishing at the stack's
 * URL, or at its `fork.of`, else the one its `id` is, with the `-fork` suffix a PPN fork carries
 * removed. Undefined when none matches.
 */
export function networkOfStack(pointer: Pointer, descriptor: Descriptor): string | undefined {
  const urls = [pointer.url, descriptor.fork?.of.url];
  const byUrl = Object.keys(NETWORKS).find((key) => urls.includes(NETWORKS[key].stack.url));
  const byId = descriptor.id.replace(/-fork$/, "");
  return byUrl ?? (byId in NETWORKS ? byId : undefined);
}

/**
 * The `NETWORKS` entry a run tests: `NETWORK` when set, else the one `STACK` is an instance or
 * a fork of, else paseo-next-v2. Fails when `NETWORK` is unknown, when `NETWORK` and `STACK` are
 * different known networks, or when `STACK` matches none and `NETWORK` is not set.
 */
export function selectNetwork(
  network: string | undefined,
  stack: { pointer: Pointer; descriptor: Descriptor } | undefined,
): string {
  if (network && !(network in NETWORKS)) {
    throw new Error(`Unknown network: ${network}. Available: ${Object.keys(NETWORKS).join(", ")}`);
  }
  const stackNetwork = stack && networkOfStack(stack.pointer, stack.descriptor);
  if (network && stackNetwork && network !== stackNetwork) {
    throw new Error(`NETWORK=${network}, but STACK=${stack.pointer.url} is ${stackNetwork}`);
  }
  if (network) return network;
  if (stack && !stackNetwork) {
    throw new Error(
      `STACK=${stack.pointer.url} (${stack.descriptor.id}) is none of ${Object.keys(NETWORKS).join(", ")}; set NETWORK`,
    );
  }
  return stackNetwork ?? DEFAULT_NETWORK;
}

/**
 * A known network's capability flags with a stack's chains, HOP endpoint, identity backend
 * and IPFS gateway. The identity backend is null when the network does not attest or the
 * stack runs none, and attestation-dependent tests then skip. On a PPN fork, whose `id` ends
 * in `-fork`, `//Alice` is the test account: sudo by bite override, and fundable.
 */
export function networkConfig(known: KnownNetwork, descriptor: Descriptor): NetworkConfig {
  const service = (kind: string) =>
    descriptor.services.find((entry) => entry.kind === kind)?.urls[0]?.replace(/\/$/, "");
  const identityBackend = known.features.identity ? (service("dub") ?? null) : null;
  const hopWs = service("hop");
  const ipfsGateway = service("ipfs-gateway");
  if (!ipfsGateway) throw new Error(`stack ${descriptor.id} has no ipfs-gateway service`);
  return {
    name: descriptor.name,
    assetHub: { ws: chain(descriptor, "AssetHub").rpc[0] },
    people: { ws: chain(descriptor, "People").rpc[0] },
    bulletin: { ws: chain(descriptor, "Bulletin").rpc[0], ...(hopWs && { hopWs }) },
    identityBackend,
    ...(identityBackend && { identityBackendAuth: "challenge" as const }),
    ipfsGateway,
    features: known.features,
    ...(descriptor.id.endsWith("-fork") && { testAccountUri: "//Alice" }),
  };
}
