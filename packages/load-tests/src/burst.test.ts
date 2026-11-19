import { describe, expect, it } from "vitest";
import { openConnections } from "./burst.js";

// One RPC node that doesn't finish a handshake must not stop a burst before it sends anything:
// the burst sends over the connections that opened and reports the others.
describe("openConnections", () => {
  it("sends over the connections that opened when one never opens", async () => {
    const attempts: Record<string, number> = {};
    const open = async (url: string) => {
      attempts[url] = (attempts[url] ?? 0) + 1;
      if (url === "wss://slow") throw new Error("Opening handshake has timed out");
      return url;
    };
    const { connections, failures } = await openConnections(["wss://a", "wss://slow", "wss://b"], 3, open, 0);

    expect(connections).toEqual(["wss://a", "wss://b"]);
    expect(failures).toEqual({ "Opening handshake has timed out": 1 });
    expect(attempts["wss://slow"]).toBe(3);
  });

  it("opens a connection whose first attempt fails", async () => {
    let calls = 0;
    const open = async (url: string) => {
      if (calls++ === 0) throw new Error("Opening handshake has timed out");
      return url;
    };
    expect(await openConnections(["wss://a"], 1, open, 0)).toEqual({ connections: ["wss://a"], failures: {} });
  });

  it("fails when no connection opens", async () => {
    const open = async (): Promise<string> => {
      throw new Error("Opening handshake has timed out");
    };
    await expect(openConnections(["wss://a"], 2, open, 0)).rejects.toThrow(/no connection of 2 opened/);
  });
});
