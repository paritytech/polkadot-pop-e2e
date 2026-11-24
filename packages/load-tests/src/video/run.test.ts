import { describe, expect, it } from "vitest";
import { parseBotSplit, turnOffsetsOf, videoGroupOf, type BotSplit } from "./run.js";

// A run mixes bots as a live game's phones mix: some on TURN, a few only able to reach their
// co-players through a relay, the rest on STUN alone, so testers keep the TURN server's ports.
describe("bot split", () => {
  const groupsOf = (offsets: number[], split: BotSplit) => offsets.map((offset) => videoGroupOf(offset, split));

  it("puts the first --relay-bots bots relay-only, the next up to --turn-bots on TURN, and the rest on STUN only", () => {
    const shard = [1, 3, 5, 7];
    expect(groupsOf(shard, parseBotSplit({ relay: false }))).toEqual(["turnAndDirect", "turnAndDirect", "turnAndDirect", "turnAndDirect"]);
    expect(groupsOf(shard, parseBotSplit({ turnBots: "0", relay: false }))).toEqual(["stunOnly", "stunOnly", "stunOnly", "stunOnly"]);
    expect(groupsOf(shard, parseBotSplit({ turnBots: "6", relayBots: "2", relay: false }))).toEqual(["relayOnly", "turnAndDirect", "turnAndDirect", "stunOnly"]);
    expect(groupsOf(shard, parseBotSplit({ turnBots: "4", relayBots: "4", relay: false }))).toEqual(["relayOnly", "relayOnly", "stunOnly", "stunOnly"]);
    expect(groupsOf(shard, parseBotSplit({ relay: true }))).toEqual(["relayOnly", "relayOnly", "relayOnly", "relayOnly"]);
    expect(turnOffsetsOf(shard, parseBotSplit({ turnBots: "4", relayBots: "2", relay: false }))).toEqual([1, 3]);
  });

  it("rejects relay-only bots without TURN, --relay with --relay-bots, and counts that aren't whole numbers", () => {
    expect(() => parseBotSplit({ turnBots: "2", relayBots: "3", relay: false })).toThrow(
      "--relay-bots 3 makes 3 bots relay-only, but --turn-bots 2 gives TURN to fewer: a relay-only bot without TURN can't connect",
    );
    expect(() => parseBotSplit({ turnBots: "2", relay: true })).toThrow("--relay makes every bot relay-only, but --turn-bots 2 gives TURN to fewer");
    expect(() => parseBotSplit({ relayBots: "1", relay: true })).toThrow("pass --relay or --relay-bots, not both");
    expect(() => parseBotSplit({ relayBots: "-1", relay: false })).toThrow("--relay-bots must be a non-negative integer, not '-1'");
    expect(() => parseBotSplit({ turnBots: "1.5", relay: false })).toThrow("--turn-bots must be a non-negative integer, not '1.5'");
  });
});
