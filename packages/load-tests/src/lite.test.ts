import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { identityKey, liteRingEntropy } from "@pop-e2e/chain-tests/src/lib/truapi-identity.js";
import { describe, expect, it } from "vitest";
import { hostMnemonic } from "./keys.js";
import { attestFailure, deriveLiteBot, LITE_FIRST_INDEX, withoutDescriptorNotice } from "./lite.js";

describe("deriveLiteBot", () => {
  // A lite bot is attested as truapi's identity account, so a rerun finds the same lite person.
  it("derives the keys truapi derives for the bot's own wallet", () => {
    const bot = deriveLiteBot("lite-test", "dim2.testnet", "testnet", LITE_FIRST_INDEX + 3);
    const entropy = mnemonicToEntropy(hostMnemonic("lite-test", LITE_FIRST_INDEX + 3));
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

  it("reports any other failure by its first line", () => {
    expect(attestFailure("[truapi-host] attest failed: Error: ring member not found\nbacktrace")).toBe("Error: ring member not found");
  });

  // truapi-host opens every run on paseo-next-v2 with this notice, so it can't name the failure.
  it("reports the error behind truapi-host's descriptor notice", () => {
    const message = withoutDescriptorNotice(
      "[truapi-host] attest failed: the published paseo-next-v2 stack descriptor (sequence 1794930301) changes the copy this truapi-host ships (sequence 1793615287) and is in use; a later truapi-host release ships it\nError: ring member not found",
    );
    expect(attestFailure(message)).toBe("Error: ring member not found");
  });
});
