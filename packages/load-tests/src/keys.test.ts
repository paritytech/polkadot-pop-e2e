import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { productAccountKey } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { describe, expect, it } from "vitest";
import { hostGhostPlayer, hostMnemonic } from "./keys.js";

// truapi-host signs a ghost's statements with its product account, so the account a run signs up
// and funds has to be the one truapi derives, however the run caches the derivation.
describe("hostGhostPlayer", () => {
  it("is the product account truapi derives for the ghost's host and index", () => {
    for (const index of [0, 9, 10, 23]) {
      const host = Math.floor(index / 10);
      const expected = productAccountKey(mnemonicToEntropy(hostMnemonic("keys-test", host)), "dim2.testnet", index % 10);
      expect(hostGhostPlayer("keys-test", "dim2.testnet", 10, index).address).toBe(expected.address);
    }
  });
});
