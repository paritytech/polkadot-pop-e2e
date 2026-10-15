import { describe, expect, it } from "vitest";
import { toHex } from "polkadot-api/utils";
import { identityKey, indexBytes, liteRingEntropy } from "../../lib/truapi-identity.js";

// Vectors from truapi's host_logic/product_account.rs tests.
describe("truapi identity derivation", () => {
  it("index_bytes matches the mobile vector", () => {
    expect(toHex(indexBytes(0))).toBe(
      "0x0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f",
    );
  });

  it("identity account follows the network suffix", () => {
    const entropy = new Uint8Array(16).fill(0xab);
    expect(identityKey(entropy, "paseo").address).toBe(
      "5CtVJYWUwK7WksAU9CDm6u58ucgKkmWPE26TKhjjwiJKo2hW",
    );
    expect(identityKey(entropy, "testnet").address).toBe(
      "5DhuA7ba5CxLtFjuU4YkAeCoCCH1YV1jjUUjFf3W5VSEmRxx",
    );
  });

  it("lite ring-VRF entropy matches truapi", () => {
    const entropy = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    expect(toHex(liteRingEntropy(entropy, "dot"))).toBe(
      "0x8d7f5e1510a7e8d813887e100f5a260ec9de60e68695477b93360ee7e3d16a9f",
    );
    expect(toHex(liteRingEntropy(entropy, "testnet"))).toBe(
      "0x574bdaa99061a6a88442c3d90207de487a753fc7da34f960e305e9d9152bb060",
    );
  });
});
