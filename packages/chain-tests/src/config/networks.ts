import type { Address } from "viem";

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
  },
  "paseo-review": {
    name: "Paseo Review",
    assetHub: { ws: "wss://asset-hub-paseo-rpc.n.dwellir.com" },
    people: { ws: "wss://paseo-people-review-rpc.polkadot.io" },
    bulletin: { ws: "wss://paseo-bulletin-review-rpc.polkadot.io" },
    contracts: {
      dotnsRegistry: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
      dotnsContentResolver: "0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7",
    },
    identityBackend: "https://identity-backend-review.parity-testnet.parity.io",
    ipfsGateway: "https://paseo-bulletin-review-ipfs.polkadot.io",
  },
  preview: {
    name: "Preview",
    assetHub: { ws: "wss://previewnet.substrate.dev/asset-hub" },
    people: { ws: "wss://pop3-testnet.parity-lab.parity.io/people" },
    bulletin: { ws: "wss://previewnet.substrate.dev/bulletin" },
    contracts: null,
    identityBackend: null,
    ipfsGateway: "https://paseo-ipfs.polkadot.io",
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
