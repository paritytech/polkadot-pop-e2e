import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseoNextPeople, previewPeople } from "@pop-e2e/papi";
import { keypairFromUri, type Keypair } from "./keys.js";

export type PeopleApi = TypedApi<typeof previewPeople>;

const PEOPLE_DESCRIPTORS = { previewnet: previewPeople, "paseo-next-v2": paseoNextPeople } as const;
type DescriptorNetwork = keyof typeof PEOPLE_DESCRIPTORS;

/** The People chain a run loads: where to connect, how to sign as root, what to scrape. */
export interface Target {
  label: string;
  /** People RPC endpoints; ghosts spread their connections over all of them. */
  rpc: string[];
  network: DescriptorNetwork;
  /** Root's key: `//Alice` on a PPN fork, `SUDO_URI` elsewhere; none on a live network by default. */
  sudo: Keypair | undefined;
  /** Pays players who join a real game: root's key when there is one, else `TEST_MNEMONIC`. */
  funder: Keypair | undefined;
  /** Prometheus endpoints of the People nodes behind `rpc`, scraped around each step. */
  metrics: string[];
  /** truapi-host environment that routes a host to this target's chains and identity backend. */
  hostEnv: Record<string, string>;
}

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
 * chain-tests read it. `rpc` replaces the stack's People endpoint for ghosts and hosts alike,
 * such as a fork's node port in place of the dashboard proxy in front of it. Without `STACK`,
 * `rpc` alone is the whole target, such as a local dev node.
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
      // A host connects to a dev node through HOST_CLI_LOCAL_NETWORK_CONFIG, which it inherits.
      hostEnv: {},
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
    hostEnv: {
      HOST_CLI_PEOPLE_WS: rpc[0],
      HOST_CLI_ASSET_HUB_WS: config.assetHub.ws,
      HOST_CLI_BULLETIN_WS: config.bulletin.ws,
      ...(config.identityBackend && { HOST_CLI_IDENTITY_BACKEND_BASE: config.identityBackend }),
    },
  };
}

export function peopleApiOf(client: PolkadotClient, target: Target): PeopleApi {
  return client.getTypedApi(PEOPLE_DESCRIPTORS[target.network]) as PeopleApi;
}

export function connectPeople(target: Target): { client: PolkadotClient; api: PeopleApi } {
  const client = createClient(getWsProvider(target.rpc[0]));
  return { client, api: peopleApiOf(client, target) };
}
