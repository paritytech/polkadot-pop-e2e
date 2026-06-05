import type { Address } from "viem";

/** Per-network capability flags — drives test gating. */
export interface NetworkFeatures {
  /** `pallet-resources` allowance flow (StmtStore + LongTermStorage claims). */
  resources: boolean;
  /** `pallet-pgas` claim + `pallet-revive` PGAS-paid contract calls. */
  pgas: boolean;
  /**
   * Runtime is on individuality v0.7.0+ (verifiable rev `f65b39df` or newer,
   * post-ThinVRF). When true, ring-VRF proofs are 64 bytes (ThinVRF); when
   * false, they're 96 bytes (pre-ThinVRF). Drop this flag the moment every
   * tracked network is on v0.7.0+ and bump the dep to a single pin.
   */
  thinVrf: boolean;
}

export interface NetworkConfig {
  name: string;
  assetHub: { ws: string };
  people: { ws: string };
  bulletin: { ws: string };
  contracts: {
    dotnsRegistry: Address;
    dotnsContentResolver: Address;
  } | null;
  identityBackend: string | null;
  ipfsGateway: string;
  features: NetworkFeatures;
  // Optional URI override for the keyring. When set, used instead of
  // the `TEST_MNEMONIC` env. Useful on dev testnets like previewnet
  // where `//Alice` is pre-funded.
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
    bulletin: { ws: "wss://paseo-bulletin-next-rpc.polkadot.io" },
    contracts: null,
    identityBackend: "https://identity-backend-next.parity-testnet.parity.io",
    ipfsGateway: "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs",
    features: { resources: true, pgas: true, thinVrf: true },
  },
  summit: {
    name: "Summit",
    // Summit testnet — relay + AH + Bulletin + People all under the
    // `summit-*.polkadot.io` umbrella. No relay field in NetworkConfig
    // (chain-tests doesn't drive the relay directly), but the endpoint
    // is wss://summit-rpc.polkadot.io if a future probe needs it.
    assetHub: { ws: "wss://summit-asset-hub-rpc.polkadot.io" },
    people: { ws: "wss://summit-people-rpc.polkadot.io" },
    bulletin: { ws: "wss://summit-bulletin-rpc.polkadot.io" },
    contracts: null,
    // IB + IPFS gateway not deployed yet — Statement, attested-PGAS, and
    // authorized-Bulletin tests will fail loudly until these come online.
    // That's the desired signal: we want to know when Summit's auxiliary
    // services land, not silently green-pass against placeholders.
    identityBackend: null,
    ipfsGateway: "",
    features: { resources: true, pgas: true, thinVrf: true },
  },
  previewnet: {
    name: "Previewnet",
    assetHub: { ws: "wss://previewnet.substrate.dev/asset-hub" },
    people: { ws: "wss://previewnet.substrate.dev/people" },
    bulletin: { ws: "wss://previewnet.substrate.dev/bulletin" },
    contracts: null,
    identityBackend: "https://polkadot-app-stg.parity.io",
    ipfsGateway: "https://previewnet.substrate.dev/ipfs",
    features: { resources: true, pgas: true, thinVrf: true },
    // previewnet is a dev testnet — `//Alice` is pre-funded, so we don't
    // need a TEST_MNEMONIC secret to drive funded ops.
    testAccountUri: "//Alice",
  },
};

export function getNetworkConfig(): NetworkConfig {
  const name = process.env.NETWORK ?? "paseo-next-v2";
  const config = NETWORKS[name];
  if (!config) {
    throw new Error(
      `Unknown network: ${name}. Available: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return config;
}
