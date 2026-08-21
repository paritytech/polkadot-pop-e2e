import type { Address } from "viem";

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
  contracts: {
    dotnsRegistry: Address;
    dotnsContentResolver: Address;
  } | null;
  identityBackend: string | null;
  /**
   * How identity-backend writes authenticate. Absent = legacy IBv1: HS256 over the
   * shared `IB_JWT_SECRET` env (no header when unset). "challenge" = IBv2
   * (identity-backend-rust): the backend issues the JWT itself via its
   * challenge→token flow, signed with the person's own key — no shared secret.
   */
  identityBackendAuth?: "challenge";
  /**
   * The runtime's NetworkSuffix param — the network half of individuality
   * v0.12's hashed product contexts ("product/peopl.<suffix>/…"). "test" on
   * previewnet, "paseo" on pnv2. Irrelevant on pre-v0.12 runtimes.
   */
  networkSuffix?: string;
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
    bulletin: {
      ws: "wss://paseo-bulletin-next-rpc.polkadot.io",
      hopWs: "wss://paseo-hop-next-0.polkadot.io",
    },
    contracts: null,
    // device-uniqueness-backend (the new IB) — challenge→token auth.
    identityBackend: "https://identity.dotspark.app",
    identityBackendAuth: "challenge",
    networkSuffix: "paseo",
    ipfsGateway: "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs",
    features: { resources: true, pgas: true, hop: true },
  },
  previewnet: {
    name: "Previewnet",
    assetHub: { ws: "wss://previewnet.substrate.dev/asset-hub" },
    people: { ws: "wss://previewnet.substrate.dev/people" },
    bulletin: { ws: "wss://previewnet.substrate.dev/bulletin" },
    contracts: null,
    // device-uniqueness-backend (the new IB) — challenge→token auth.
    identityBackend: "https://identity-previewnet.dotspark.app",
    identityBackendAuth: "challenge",
    networkSuffix: "test",
    ipfsGateway: "https://previewnet.substrate.dev/ipfs",
    features: { resources: true, pgas: true, hop: true },
    // previewnet is a dev testnet — `//Alice` is pre-funded, so we don't
    // need a TEST_MNEMONIC secret to drive funded ops.
    testAccountUri: "//Alice",
  },
  // The community-operated Polkadot Products Devnet: the REAL Paseo system chains
  // (Asset Hub 1000, People 1004) plus Bulletin 1010 on the public relay —
  // https://docs.polkadotcommunity.foundation/reference/networks/. None of the
  // next-runtime features exist here (no pallet-resources/pgas, no HOP, no
  // identity backend), so only the chain-level health portion of the suite runs.
  // Exists primarily as a release-gate base network (FORK_OF=devnet).
  devnet: {
    name: "Polkadot Products Devnet",
    assetHub: { ws: "wss://asset-hub-paseo-rpc.n.dwellir.com" },
    people: { ws: "wss://people-paseo.rotko.net" },
    bulletin: { ws: "wss://bulletin-paseo.tservices.es:8443" },
    contracts: null,
    identityBackend: null,
    ipfsGateway: "https://devnet-ipfs.api.polkadotcommunity.foundation/ipfs",
    features: { resources: false, pgas: false, hop: false },
  },
};

/**
 * A locally spawned fork of a known network — `make start FORK=1` in the engine
 * (paritytech/preview-net-v1), as used by the release-gate workflow.
 *
 * Fork configs are DERIVED, not enumerated: a fork of X carries X's capability flags
 * and chain set (it is X's state), so everything is inherited from `NETWORKS[X]` and
 * only the transport is swapped — the engine's fixed local ports (its config/ports.env;
 * `FORK_*` env overrides for a remotely spawned instance), the local IBv2 gateway when
 * the base network runs an identity backend, and `//Alice` as the test account
 * (sudo on every fork by bite override, and fundable on every fork). Adding a network
 * to the gate therefore needs no new entry here — `FORK_OF=<network>` is enough.
 */
function localForkConfig(baseName: string): NetworkConfig {
  const base = NETWORKS[baseName];
  if (!base) {
    throw new Error(
      `Unknown FORK_OF network: ${baseName}. Available: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return {
    ...base,
    name: `Local fork of ${base.name}`,
    assetHub: { ws: process.env.FORK_ASSET_HUB_WS ?? "ws://127.0.0.1:10020" },
    people: { ws: process.env.FORK_PEOPLE_WS ?? "ws://127.0.0.1:10010" },
    // Replacing the whole object deliberately drops any remote `hopWs` from the base:
    // on a fork the local collator runs `--enable-hop`, so the plain ws serves HOP.
    bulletin: { ws: process.env.FORK_BULLETIN_WS ?? "ws://127.0.0.1:10030" },
    // The engine runs identity-backend-rust (IBv2) locally — even when the base
    // network's deployment is IBv1. FORK_IDENTITY_BACKEND=none says this network's
    // fork spawns NO identity backend at all (pnv2/devnet forks run only eth-rpc
    // beside the chains) — attestation-dependent tests then skip.
    identityBackend:
      base.identityBackend && process.env.FORK_IDENTITY_BACKEND !== "none"
        ? (process.env.FORK_IDENTITY_BACKEND ?? "http://127.0.0.1:8092")
        : null,
    ...(base.identityBackend && process.env.FORK_IDENTITY_BACKEND !== "none"
      ? { identityBackendAuth: "challenge" as const }
      : {}),
    ipfsGateway: process.env.FORK_IPFS_GATEWAY ?? "http://127.0.0.1:8080/ipfs",
    testAccountUri: "//Alice",
  };
}

export function getNetworkConfig(): NetworkConfig {
  const name = process.env.NETWORK ?? "paseo-next-v2";
  if (name === "local-fork") {
    return localForkConfig(process.env.FORK_OF ?? "previewnet");
  }
  const config = NETWORKS[name];
  if (!config) {
    throw new Error(
      `Unknown network: ${name}. Available: ${Object.keys(NETWORKS).join(", ")}, local-fork`,
    );
  }
  return config;
}
