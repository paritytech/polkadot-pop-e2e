import type { Address } from "viem";

/** Per-network capability flags — drives test gating. */
export interface NetworkFeatures {
  /** `pallet-resources` allowance flow (StmtStore + LongTermStorage claims). */
  resources: boolean;
  /** `pallet-pgas` claim + `pallet-revive` PGAS-paid contract calls. */
  pgas: boolean;
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
  "paseo-next": {
    name: "Paseo Next",
    assetHub: { ws: "wss://asset-hub-paseo-rpc.n.dwellir.com" },
    people: { ws: "wss://paseo-people-next-rpc.polkadot.io" },
    bulletin: { ws: "wss://paseo-bulletin-rpc.polkadot.io" },
    contracts: {
      dotnsRegistry: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
      dotnsContentResolver: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7",
    },
    identityBackend: "https://identity-backend.parity-testnet.parity.io",
    ipfsGateway: "https://paseo-ipfs.polkadot.io/ipfs",
    features: { resources: true, pgas: false },
  },
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
    features: { resources: true, pgas: true },
  },
  previewnet: {
    name: "Previewnet",
    assetHub: { ws: "wss://previewnet.substrate.dev/asset-hub" },
    people: { ws: "wss://previewnet.substrate.dev/people" },
    bulletin: { ws: "wss://previewnet.substrate.dev/bulletin" },
    contracts: null,
    identityBackend: "https://polkadot-app-stg.parity.io",
    ipfsGateway: "https://previewnet.substrate.dev/ipfs",
    features: { resources: true, pgas: true },
    // previewnet is a dev testnet — `//Alice` is pre-funded, so we don't
    // need a TEST_MNEMONIC secret to drive funded ops.
    testAccountUri: "//Alice",
  },
};

export function getNetworkConfig(): NetworkConfig {
  const name = process.env.NETWORK ?? "paseo-next";
  const config = NETWORKS[name];
  if (!config) {
    throw new Error(
      `Unknown network: ${name}. Available: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return config;
}
