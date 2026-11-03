// The suite reaches every chain and service through a stack's descriptor, so a wrong mapping
// points a run at the wrong network or skips tests it should run. Offline: no descriptor is
// fetched.
import { describe, expect, it } from "vitest";
import type { Descriptor } from "@parity/trinity-stack";
import { NETWORKS, networkConfig, selectNetwork } from "../../config/stack-config.js";

const DEVNET_URL = NETWORKS.devnet.stack.url;
const FORK_URL = "http://127.0.0.1:8090/.well-known/trinity-stack.json";

const servedAt = (url: string, served: Descriptor) => ({ pointer: { url }, descriptor: served });

function descriptor(extra: Partial<Descriptor> = {}): Descriptor {
  const chain = (role: string, path: string) => ({
    role,
    genesisHash: `0x${"11".repeat(32)}`,
    rpc: [`ws://127.0.0.1:8090/${path}`, `ws://127.0.0.1:8090/${path}-2`],
  });
  return {
    $v: 1,
    sequence: 1,
    generation: "g",
    id: "previewnet-fork",
    name: "Fork of Previewnet",
    network: "paseo",
    tld: "testnet",
    chains: [chain("Relay", "relay"), chain("AssetHub", "asset-hub"), chain("People", "people"), chain("Bulletin", "bulletin")],
    services: [
      { kind: "dub", urls: ["http://127.0.0.1:8090/dub/"] },
      { kind: "ipfs-gateway", urls: ["http://127.0.0.1:8090/ipfs/"] },
      { kind: "hop", urls: ["ws://127.0.0.1:8090/bulletin"] },
    ],
    ...extra,
  };
}

describe("selectNetwork", () => {
  it("runs a fork as the network it is a fork of", () => {
    expect(selectNetwork(undefined, servedAt(FORK_URL, descriptor()))).toBe("previewnet");
  });

  it("finds a network by the URL it publishes at, whatever the descriptor's id", () => {
    const pcf = descriptor({ id: "pcf-devnet" });
    expect(selectNetwork(undefined, servedAt(DEVNET_URL, pcf))).toBe("devnet");
    const fork = descriptor({ id: "pcf-devnet-fork", fork: { of: { url: DEVNET_URL }, at: 1 } });
    expect(selectNetwork(undefined, servedAt(FORK_URL, fork))).toBe("devnet");
  });

  // A previewnet fork tested with paseo-next-v2's features, papi descriptors and CLI preset
  // fails in ways that point away from the cause.
  it("rejects a NETWORK that is not the stack's network", () => {
    const stack = servedAt(FORK_URL, descriptor());
    expect(() => selectNetwork("paseo-next-v2", stack)).toThrow(/NETWORK=paseo-next-v2, but STACK=.* is previewnet/);
    expect(selectNetwork("previewnet", stack)).toBe("previewnet");
  });

  it("needs NETWORK for a stack it cannot place", () => {
    const stack = servedAt(FORK_URL, descriptor({ id: "elsewhere" }));
    expect(() => selectNetwork(undefined, stack)).toThrow(/set NETWORK/);
    expect(selectNetwork("previewnet", stack)).toBe("previewnet");
  });

  it("rejects an unknown NETWORK and defaults to paseo-next-v2", () => {
    expect(() => selectNetwork("local-fork", undefined)).toThrow(/Unknown network: local-fork/);
    expect(selectNetwork(undefined, undefined)).toBe("paseo-next-v2");
  });
});

describe("networkConfig", () => {
  it("takes the chains and services from the stack and the features from the network", () => {
    expect(networkConfig(NETWORKS.previewnet, descriptor())).toEqual({
      name: "Fork of Previewnet",
      assetHub: { ws: "ws://127.0.0.1:8090/asset-hub" },
      people: { ws: "ws://127.0.0.1:8090/people" },
      bulletin: { ws: "ws://127.0.0.1:8090/bulletin", hopWs: "ws://127.0.0.1:8090/bulletin" },
      identityBackend: "http://127.0.0.1:8090/dub",
      ipfsGateway: "http://127.0.0.1:8090/ipfs",
      tld: "testnet",
      features: NETWORKS.previewnet.features,
      testAccountUri: "//Alice",
    });
  });

  // `//Alice` is sudo only where a bite made it so; elsewhere the run needs TEST_MNEMONIC.
  it("uses //Alice only on a fork", () => {
    expect(networkConfig(NETWORKS.previewnet, descriptor({ id: "previewnet" })).testAccountUri).toBeUndefined();
  });

  // A devnet fork runs a DUB like any fork with People, but truapi-host cannot attest there.
  it("has no identity backend where the network does not attest or the stack runs none", () => {
    const devnet = networkConfig(NETWORKS.devnet, descriptor({ id: "devnet-fork" }));
    expect(devnet.identityBackend).toBeNull();
    const noDub = descriptor({ services: descriptor().services.filter((entry) => entry.kind !== "dub") });
    expect(networkConfig(NETWORKS.previewnet, noDub).identityBackend).toBeNull();
  });

  it("fails on a stack without an IPFS gateway or a chain the suite tests", () => {
    const noIpfs = descriptor({ services: descriptor().services.filter((entry) => entry.kind !== "ipfs-gateway") });
    expect(() => networkConfig(NETWORKS.previewnet, noIpfs)).toThrow(/ipfs-gateway/);
    const noPeople = descriptor({ chains: descriptor().chains.filter((entry) => entry.role !== "People") });
    expect(() => networkConfig(NETWORKS.previewnet, noPeople)).toThrow(/People/);
  });
});
