/**
 * DotNS reads beyond name resolution, as product-sdk's identity module runs them on
 * Asset Hub: availability, reverse resolution and address discovery. These only read,
 * so they never touch the registration or record-setting calls.
 */
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PolkadotClient } from "polkadot-api";
import { createContractRuntimeFromClient, type ContractRuntime } from "@parity/product-sdk-contracts";
import {
  DOTNS_ADDRESSES,
  discoverDotNsAddresses,
  isDotNsAvailable,
  resolveDotNs,
  resolveDotNsAddresses,
  reverseDotNs,
  verifyDotNsAddresses,
} from "@parity/product-sdk/identity";
import { createAssetHubClient, descriptorsForNetwork } from "../lib/client.js";
import { assertChainHealthy } from "../lib/chain-cascade.js";
import { getNetworkConfig } from "../config/networks.js";

const KNOWN_NAME = "host-playground";
const H160 = /^0x[0-9a-fA-F]{40}$/;

/** Lowercases every address, so the comparison ignores EIP-55 checksum casing. */
function lowercased(addresses: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(addresses as Record<string, string>).map(([role, address]) => [role, address.toLowerCase()]),
  );
}

describe.skipIf(!getNetworkConfig().features.dotns)("DotNS: reads beyond resolution (product-sdk)", () => {
  let client: PolkadotClient;
  let runtime: ContractRuntime;

  beforeAll(() => {
    assertChainHealthy("asset-hub");
    ({ client } = createAssetHubClient(getNetworkConfig().assetHub.ws));
    runtime = createContractRuntimeFromClient(client, descriptorsForNetwork().assetHub, {
      at: "finalized",
    });
  });

  afterAll(() => {
    client?.destroy();
  });

  // A label of 45 characters is valid and was never minted, so the registrar reports it claimable.
  it("reports a long random label as available", async () => {
    const label = `pop-e2e-free-${randomBytes(16).toString("hex")}`;
    const available = await isDotNsAvailable(label, { runtime });
    if (!available.ok) throw available.error;
    expect(available.value).toBe(true);
  });

  // The known name is registered, so it is not claimable. Resolving it first confirms that
  // the "not available" answer comes from registration, not from a reservation.
  it("reports the known registered name as not available", async () => {
    const resolved = await resolveDotNs(KNOWN_NAME, { runtime });
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value).not.toBeNull();

    const available = await isDotNsAvailable(KNOWN_NAME, { runtime });
    if (!available.ok) throw available.error;
    expect(available.value).toBe(false);
  });

  // A fresh account has no primary name, which the SDK reports as null.
  it("reverse-resolves a fresh random address to null", async () => {
    const address = `0x${randomBytes(20).toString("hex")}`;
    const name = await reverseDotNs(address, { runtime });
    if (!name.ok) throw name.error;
    expect(name.value).toBeNull();
  });

  // The docs fix only two outcomes, a name or null, so the test asserts the type. The test
  // reverses the owner when the name has no forward address, a choice of this test. The SDK
  // has no such fallback.
  it("reverse-resolves the known name's address to a name or null", async () => {
    const record = await resolveDotNs(KNOWN_NAME, { runtime });
    if (!record.ok) throw record.error;
    expect(record.value).not.toBeNull();
    const target = record.value?.address ?? record.value?.owner;
    expect(target).toMatch(H160);

    const name = await reverseDotNs(target!, { runtime });
    if (!name.ok) throw name.error;
    if (name.value !== null) expect(name.value.length).toBeGreaterThan(0);
  });

  // Previewnet's DotnsGateway.DispatcherAddress is the PoP controller, not a RootGatewayDispatcher,
  // so the walk's TARGET() call reverts there. See `dotnsDiscovery` in config/stack-config.ts.
  describe.skipIf(!getNetworkConfig().features.dotnsDiscovery)("address discovery", () => {
    // Discovery walks DotnsGateway on chain. A complete set of six H160 addresses that match the
    // pinned table means the walk reached every role and the pinned table is current.
    it("discovers all six DotNS addresses from the gateway", async () => {
      const discovered = await discoverDotNsAddresses({ runtime });
      if (!discovered.ok) throw discovered.error;
      expect(Object.keys(discovered.value).sort()).toEqual(Object.keys(DOTNS_ADDRESSES).sort());
      for (const address of Object.values(discovered.value)) expect(address).toMatch(H160);
      expect(lowercased(discovered.value)).toEqual(lowercased(DOTNS_ADDRESSES));
    });

    // Verify compares the pinned table with the walk and fails on any drift.
    it("verifies the pinned DotNS addresses against the chain", async () => {
      const verified = await verifyDotNsAddresses({ runtime });
      if (!verified.ok) throw verified.error;
    });

    // Resolving the known name through chain-discovered addresses must give the same record as
    // the pinned default. This checks that discovery and the pinned table agree on what is used.
    it("resolves the known name the same through discovered addresses", async () => {
      const discovered = await resolveDotNsAddresses({ runtime, addressSource: "discovered" });
      if (!discovered.ok) throw discovered.error;

      const pinned = await resolveDotNs(KNOWN_NAME, { runtime });
      const viaChain = await resolveDotNs(KNOWN_NAME, { runtime, addressSource: "discovered" });
      if (!pinned.ok) throw pinned.error;
      if (!viaChain.ok) throw viaChain.error;
      expect(viaChain.value).toEqual(pinned.value);
    });
  });
});
