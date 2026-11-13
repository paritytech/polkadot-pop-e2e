import type { Descriptor, Pointer } from "@parity/trinity-stack";
import { chain, service } from "@parity/trinity-stack/reader";

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
   * Attestation through the stack's identity backend, with the truapi-host CLI preset of the
   * same name: previewnet and paseo-next-v2 have one.
   */
  identity: boolean;
  /** People runs pallet-game: the Game sign-up, draws and prizes product-sdk reads. */
  game: boolean;
  /**
   * DotnsGateway.DispatcherAddress points at a RootGatewayDispatcher, which product-sdk's address
   * discovery walks (TARGET() → protocolRegistry()). Previewnet's points at the PoP controller
   * itself, so discovery cannot work there yet (#116).
   */
  dotnsDiscovery: boolean;
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
  ipfsGateway: string;
  /** The dotNS TLD the person's identities derive under. */
  tld: string;
  features: NetworkFeatures;
  // Optional URI override for the keyring. When set, used instead of
  // the `TEST_MNEMONIC` env. Used on local forks, where `//Alice` is funded.
  testAccountUri?: string;
}

/** A network the suite knows: where its operator publishes its descriptor, and what it runs. */
export interface NetworkEntry {
  stack: Pointer;
  features: NetworkFeatures;
}

export const NETWORKS: Record<string, NetworkEntry> = {
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
    features: { resources: true, pgas: true, hop: true, dotns: true, identity: true, game: true, dotnsDiscovery: true },
  },
  previewnet: {
    stack: {
      url: "https://previewnet.substrate.dev/.well-known/trinity-stack.json",
      key: "0x4d43362f03d5511632a210632d1fb7760b5a663580f12ffca34619f79357e239",
    },
    features: { resources: true, pgas: true, hop: true, dotns: true, identity: true, game: true, dotnsDiscovery: false },
  },
  // The community-operated Polkadot Products Devnet: the REAL Paseo system chains
  // (Asset Hub 1000, People 1004) plus Bulletin 1010 on the public relay —
  // https://docs.polkadotcommunity.foundation/reference/networks/. None of the
  // next-runtime features exist here, and truapi-host doesn't have a preset for it, so only the
  // chain-level health portion of the suite runs. Exists primarily as a network the
  // release gate forks.
  devnet: {
    stack: {
      url: "https://stack.api.polkadotcommunity.foundation/.well-known/trinity-stack.json",
      key: "0x1fbc5eed0deb09fe4eeefdf45350b4b4cf36370d9bbb93ca2818b076737a0ed3",
    },
    features: { resources: false, pgas: false, hop: false, dotns: false, identity: false, game: true, dotnsDiscovery: false },
  },
};

const DEFAULT_NETWORK = "paseo-next-v2";

/** The id suffix a PPN fork carries: a fork of `previewnet` has the id `previewnet-fork`. */
const FORK_ID = /-fork$/;

/**
 * The `NETWORKS` entry a stack is an instance or a fork of: the one publishing at the stack's
 * URL, or at its `fork.of`, else the one its `id` is, with the `-fork` suffix a PPN fork carries
 * removed. Undefined when none matches.
 */
function networkOfStack(pointer: Pointer, descriptor: Descriptor): string | undefined {
  const urls = [pointer.url, descriptor.fork?.of.url];
  const byUrl = Object.keys(NETWORKS).find((key) => urls.includes(NETWORKS[key].stack.url));
  const byId = descriptor.id.replace(FORK_ID, "");
  return byUrl ?? (byId in NETWORKS ? byId : undefined);
}

/**
 * The `NETWORKS` entry a run tests: `NETWORK` when set, else the one `STACK` is an instance or
 * a fork of, else paseo-next-v2. Fails when `NETWORK` is unknown, when `NETWORK` and `STACK` are
 * different known networks, or when `STACK` doesn't match one and `NETWORK` is not set.
 */
export function selectNetwork(
  network: string | undefined,
  stack: { pointer: Pointer; descriptor: Descriptor } | undefined,
): string {
  const networkList = Object.keys(NETWORKS).join(", ");
  if (network && !(network in NETWORKS)) throw new Error(`Unknown network: ${network}. Available: ${networkList}`);
  if (!stack) return network ?? DEFAULT_NETWORK;
  const stackNetwork = networkOfStack(stack.pointer, stack.descriptor);
  if (network && stackNetwork && network !== stackNetwork) {
    throw new Error(`NETWORK=${network}, but STACK=${stack.pointer.url} is ${stackNetwork}`);
  }
  if (network) return network;
  if (!stackNetwork) {
    throw new Error(`STACK=${stack.pointer.url} (${stack.descriptor.id}) doesn't match any of ${networkList}; set NETWORK`);
  }
  return stackNetwork;
}

/**
 * A known network's capability flags with a stack's chains, HOP endpoint, identity backend
 * and IPFS gateway. The identity backend is null when the network does not attest or the
 * stack doesn't run one, and attestation-dependent tests then skip. On a PPN fork `//Alice` is
 * the test account: sudo by bite override, and fundable.
 */
export function buildNetworkConfig(entry: NetworkEntry, descriptor: Descriptor): NetworkConfig {
  const optionalUrl = (kind: string) =>
    descriptor.services.find((entry) => entry.kind === kind)?.urls[0]?.replace(/\/$/, "");
  const identityBackend = entry.features.identity ? (optionalUrl("dub") ?? null) : null;
  const hopWs = optionalUrl("hop");
  return {
    name: descriptor.name,
    assetHub: { ws: chain(descriptor, "AssetHub").rpc[0] },
    people: { ws: chain(descriptor, "People").rpc[0] },
    bulletin: { ws: chain(descriptor, "Bulletin").rpc[0], ...(hopWs && { hopWs }) },
    identityBackend,
    ipfsGateway: service(descriptor, "ipfs-gateway").urls[0].replace(/\/$/, ""),
    tld: descriptor.tld,
    features: entry.features,
    ...(FORK_ID.test(descriptor.id) && { testAccountUri: "//Alice" }),
  };
}
