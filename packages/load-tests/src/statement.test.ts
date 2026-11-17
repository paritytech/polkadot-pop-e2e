import { toHex } from "@polkadot-api/utils";
import { describe, expect, it } from "vitest";
import { derivePlayer } from "./keys.js";
import { probePayload, readProbe, signStatement, topicOf } from "./statement.js";

// Receivers measure latency from the probe they find in the statement bytes, so the probe has
// to come back unchanged from a signed statement as the node delivers it, and from host data.
describe("probe", () => {
  const probe = { sender: 4_242, sequence: 17, sentAt: 1_790_000_000_123.5 };

  it("is read back from a signed SCALE statement", async () => {
    const statement = await signStatement(derivePlayer("test", 1), {
      topics: [topicOf("room")],
      channel: topicOf("channel"),
      expirySeconds: 1_790_000_030,
      sequence: 3,
      data: probePayload(probe, 6_000),
    });
    expect(readProbe(statement)).toEqual(probe);
  });

  it("is read back from statement data in hex", () => {
    expect(readProbe(toHex(probePayload(probe, 300)))).toEqual(probe);
  });

  it("is absent from statements without one", async () => {
    const statement = await signStatement(derivePlayer("test", 1), {
      topics: [topicOf("room")],
      channel: topicOf("channel"),
      expirySeconds: 1_790_000_030,
      sequence: 3,
      data: new TextEncoder().encode("another product's statement"),
    });
    expect(readProbe(statement)).toBeUndefined();
  });
});
