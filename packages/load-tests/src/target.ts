import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import type { PeopleClient as AppPeopleClient } from "@individuality/people-chain";
import { createChainEngine } from "@jollity/game-chain/engine";
import { NETWORK_CONFIG, type NetworkName } from "@jollity/protocol/src/config";
import type { GameEngine } from "@jollity/protocol/src/engine";
import { paseoNextAssetHub, paseoNextPeople, previewAssetHub, previewPeople } from "@pop-e2e/papi";
import { keypairFromUri, type Keypair } from "./keys.js";

export type PeopleApi = TypedApi<typeof previewPeople>;
export type AssetHubApi = TypedApi<typeof previewAssetHub>;

const PEOPLE_DESCRIPTORS = { previewnet: previewPeople, "paseo-next-v2": paseoNextPeople } as const;
const ASSET_HUB_DESCRIPTORS = { previewnet: previewAssetHub, "paseo-next-v2": paseoNextAssetHub } as const;
type DescriptorNetwork = keyof typeof PEOPLE_DESCRIPTORS;

/** The app's name of each network a run targets, which its config and the nfts SDK go by. */
export const APP_NETWORKS = { previewnet: "previewnet", "paseo-next-v2": "paseo" } as const satisfies Record<DescriptorNetwork, NetworkName>;

/** The product the app's game account plays as on `network`, such as `dim2.testnet`. */
export function gameProductId(network: DescriptorNetwork): string {
  return `${NETWORK_CONFIG[APP_NETWORKS[network]].productAccount}.${networkTld(network)}`;
}

/** The DotNS TLD the app's products end in on `network`, such as `testnet`. */
export function networkTld(network: DescriptorNetwork): string {
  return NETWORK_CONFIG[APP_NETWORKS[network]].dotnsTLD;
}

/** The People chain a run loads: where to connect, how to sign as root, what to scrape. */
export interface Target {
  label: string;
  /** People RPC endpoints; ghosts spread their connections over all of them. */
  rpc: string[];
  network: DescriptorNetwork;
  /** Root's key: `//Alice` on a PPN fork, `SUDO_URI` elsewhere; none on a live network by default. */
  sudo: Keypair | undefined;
  /** Pays players who sign up to a load game: root's key when there is one, else `TEST_MNEMONIC`. */
  funder: Keypair | undefined;
  /** Prometheus endpoints of the People nodes behind `rpc`, scraped around each step. */
  metrics: string[];
  /** Asset Hub RPC endpoint, where game credits are claimed as NFTs; none for a lone dev node. */
  assetHubRpc: string | undefined;
}

/** Where a target's chains are, without its keys: what a worker thread connects with. */
export type Endpoints = Pick<Target, "label" | "rpc" | "network" | "assetHubRpc">;

export interface TargetOptions {
  rpc: string[];
  network: string | undefined;
  sudoUri: string | undefined;
  metrics: string[];
}

function descriptorNetwork(network: string): DescriptorNetwork {
  if (!(network in PEOPLE_DESCRIPTORS)) {
    throw new Error(`no People descriptors for '${network}': use one of ${Object.keys(PEOPLE_DESCRIPTORS).join(", ")}`);
  }
  return network as DescriptorNetwork;
}

function funderOf(sudoUri: string | undefined): Keypair | undefined {
  const uri = sudoUri ?? process.env.TEST_MNEMONIC;
  return uri ? keypairFromUri(uri) : undefined;
}

/**
 * The stack `STACK` selects, else the network `NETWORK` (or `network`) selects, read the way the
 * chain-tests read it. `rpc` replaces the stack's People endpoint for the direct RPC clients
 * (signalling ghosts, `chain`, `mint`), such as a fork's node port in place of the dashboard proxy
 * in front of it. Without `STACK`, `rpc` alone is the whole target, such as a local dev node.
 */
export async function resolveTarget(options: TargetOptions): Promise<Target> {
  if (options.rpc.length > 0 && !process.env.STACK) {
    return {
      label: options.rpc[0],
      rpc: options.rpc,
      network: descriptorNetwork(options.network ?? process.env.NETWORK ?? "previewnet"),
      sudo: options.sudoUri ? keypairFromUri(options.sudoUri) : undefined,
      funder: funderOf(options.sudoUri),
      metrics: options.metrics,
      assetHubRpc: undefined,
    };
  }
  if (options.network) process.env.NETWORK = options.network;
  // Deferred: the module fetches the stack descriptor when it loads, which a run with `rpc` skips.
  const { getNetworkConfig, networkKey } = await import("@pop-e2e/chain-tests/src/config/networks.js");
  const config = getNetworkConfig();
  const sudoUri = options.sudoUri ?? config.testAccountUri;
  const rpc = options.rpc.length > 0 ? options.rpc : [config.people.ws];
  return {
    label: config.name,
    rpc,
    network: descriptorNetwork(networkKey()),
    sudo: sudoUri ? keypairFromUri(sudoUri) : undefined,
    funder: funderOf(sudoUri),
    metrics: options.metrics,
    assetHubRpc: config.assetHub.ws,
  };
}

export interface PeopleConnection {
  client: PolkadotClient;
  api: PeopleApi;
  /** This connection as the app's packages take a People client: this network's descriptors in place of the app's pinned ones. */
  appClient: AppPeopleClient;
  /** The Jollity app's chain engine over this connection: its game reads and its sign-up. */
  engine: GameEngine;
}

export function connectPeople(target: Endpoints): PeopleConnection {
  const client = createClient(getWsProvider(target.rpc[0]));
  const api = client.getTypedApi(PEOPLE_DESCRIPTORS[target.network]) as PeopleApi;
  const appClient: AppPeopleClient = { client, api: api as unknown as AppPeopleClient["api"] };
  return { client, api, appClient, engine: createChainEngine(appClient, { tld: NETWORK_CONFIG[APP_NETWORKS[target.network]].dotnsTLD }) };
}

export function connectAssetHub(target: Endpoints): { client: PolkadotClient; api: AssetHubApi } {
  if (!target.assetHubRpc) throw new Error(`${target.label}: no Asset Hub endpoint to claim NFTs on; run against a stack`);
  const client = createClient(getWsProvider(target.assetHubRpc));
  return { client, api: client.getTypedApi(ASSET_HUB_DESCRIPTORS[target.network]) as AssetHubApi };
}
