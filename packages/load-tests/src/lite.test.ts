import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { identityKey, liteRingEntropy } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { describe, expect, it } from "vitest";
import { hostGhostPlayer, hostMnemonic, keypairFromUri } from "./keys.js";
import { deriveLiteBot, LITE_FIRST_INDEX, requireLiteAllowed } from "./lite.js";
import type { Target } from "./target.js";

describe("deriveLiteBot", () => {
  // A lite bot is attested as truapi's identity account and plays with the game account
  // truapi-host signs with for one ghost per host, so a rerun and the host layer find the same keys.
  it("derives the keys truapi derives for the bot's own wallet", () => {
    const bot = deriveLiteBot("lite-test", "dim2.testnet", "testnet", LITE_FIRST_INDEX + 3);
    const entropy = mnemonicToEntropy(hostMnemonic("lite-test", LITE_FIRST_INDEX + 3));
    expect(bot.player.address).toBe(hostGhostPlayer("lite-test", "dim2.testnet", 1, LITE_FIRST_INDEX + 3).address);
    expect(bot.candidate.address).toBe(identityKey(entropy, "testnet").address);
    expect(bot.player.liteEntropy).toEqual(liteRingEntropy(entropy, "testnet"));
  });

  // The game account must not be a lite person itself, or the bind fails with AccountIsALitePerson.
  it("plays with an account other than the lite person", () => {
    const bot = deriveLiteBot("lite-test", "dim2.testnet", "testnet", LITE_FIRST_INDEX);
    expect(bot.player.address).not.toBe(bot.candidate.address);
  });

  // Deposit-backed bots share hosts of 10 from index 0; a lite bot must never share their wallet.
  it("uses no wallet of the deposit-backed bots", () => {
    const deposit = new Set(Array.from({ length: 5000 }, (_, index) => hostMnemonic("lite-test", Math.floor(index / 10))));
    expect(deposit.has(hostMnemonic("lite-test", LITE_FIRST_INDEX))).toBe(false);
  });
});

describe("requireLiteAllowed", () => {
  const target = { label: "previewnet" } as Target;

  // Lite people can't be removed, so a live network takes lite bots only on an explicit opt-in.
  it("refuses a network without a root key", () => {
    expect(() => requireLiteAllowed(target, undefined, false)).toThrow(/--allow-live-lite/);
  });

  it("takes a root key or the opt-in", () => {
    expect(() => requireLiteAllowed(target, keypairFromUri("//Alice"), false)).not.toThrow();
    expect(() => requireLiteAllowed(target, undefined, true)).not.toThrow();
  });
});
