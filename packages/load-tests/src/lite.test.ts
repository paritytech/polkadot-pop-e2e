import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { identityKey, liteRingEntropy } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { describe, expect, it } from "vitest";
import { hostGhostPlayer, hostMnemonic } from "./keys.js";
import { attestFailure, deriveLiteBot, LITE_FIRST_INDEX } from "./lite.js";

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

// A provisioning run counts failures by key, so DUB's rate limits have to show as their status.
describe("attestFailure", () => {
  it("keys DUB's HTTP refusals by status", () => {
    expect(attestFailure("[truapi-host] attest failed: Error: username registration failed (429 Too Many Requests): slow down")).toBe("HTTP 429");
    expect(attestFailure("[truapi-host] attest failed: Error: attestation failed (503 Service Unavailable)")).toBe("HTTP 503");
  });

  // DUB finishes a registration after truapi-host stops waiting, so the chain decides it later.
  it("keys an attest the CLI stopped waiting on as pending", () => {
    expect(attestFailure("[truapi-host] attest failed (killed after 480s): waiting for the ring")).toBe("pending");
    expect(attestFailure("[truapi-host] attest failed: Error: dotNS username did not appear on Asset Hub after attestation")).toBe("pending");
  });

  it("keeps any other failure's first line", () => {
    expect(attestFailure("[truapi-host] attest failed: Error: ring member not found\nbacktrace")).toBe("Error: ring member not found");
  });
});
