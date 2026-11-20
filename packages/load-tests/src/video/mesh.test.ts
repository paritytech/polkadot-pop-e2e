import type { RtcPayload } from "@jollity/statement-core";
import { describe, expect, it } from "vitest";
import { sleep } from "../time.js";
import { loadClip } from "./clip.js";
import { VideoMesh } from "./mesh.js";
import { VideoStats } from "./stats.js";

/** Once `condition` holds, polled on the real clock: the links are real werift connections, which fake timers don't drive. */
async function waitUntil(condition: () => boolean, ms: number): Promise<void> {
  for (const until = Date.now() + ms; !condition() && Date.now() < until; ) await sleep(100);
}

// When a link stalls, the app starts over from a fresh connection with a new offer. A bot that
// rejected it left that co-player, a real phone included, without a link for the rest of the game.
describe("VideoMesh", () => {
  it("answers an offer from a co-player's fresh connection and links again", { timeout: 30_000 }, async () => {
    const meshes = new Map<string, VideoMesh>();
    const linked: string[] = [];
    const clip = loadClip();
    const meshOf = (self: string, peer: string, stats: VideoStats) => {
      const mesh = new VideoMesh({
        self,
        window: { start: 0, end: Number.MAX_SAFE_INTEGER },
        rounds: [{ activeFrom: Date.now(), group: [peer] }],
        clip,
        ice: { stunUrls: [], turn: [], relay: false, interfaceAddress: "127.0.0.1" },
        stats,
        signal: (to: string, payload: RtcPayload) => setTimeout(() => meshes.get(to)?.onSignal(self, payload), 5),
        onLinked: (to: string, up: boolean) => up && linked.push(`${self}->${to}`),
      });
      meshes.set(self, mesh);
      mesh.open([peer]);
      return mesh;
    };
    // "a" is the lower id, so it offers.
    const answererStats = new VideoStats();
    const first = meshOf("a", "b", new VideoStats());
    const answerer = meshOf("b", "a", answererStats);
    await waitUntil(() => linked.length === 2, 10_000);
    expect(linked.sort()).toEqual(["a->b", "b->a"]);

    // The co-player starts over: its old connection is gone, and a fresh one offers.
    await first.close();
    const fresh = meshOf("a", "b", new VideoStats());
    await waitUntil(() => linked.length === 4, 10_000);
    await Promise.all([fresh.close(), answerer.close()]);

    expect(linked.sort()).toEqual(["a->b", "a->b", "b->a", "b->a"]);
    expect(answererStats.failures).toEqual({});
  });
});
