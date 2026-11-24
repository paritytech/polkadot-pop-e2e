import { describe, expect, it } from "vitest";
import type { GameEngine } from "@jollity/protocol/src/engine";
import { buildReport } from "./chain.js";
import { derivePlayer } from "./keys.js";

const player = derivePlayer("chain-test", 0);

/** The pallet's group of `index`: every `groups`-th index from its residue, below `playerCount`. */
function palletGroup(index: number, playerCount: number, maxGroupSize: number): number[] {
  const groups = Math.ceil(playerCount / maxGroupSize);
  return Array.from({ length: maxGroupSize }, (_, member) => (index % groups) + member * groups).filter((member) => member < playerCount);
}

/** An engine whose roster seats the player at `indices` and returns each group as the pallet forms it, or `members` in its place. */
function rosterEngine(indices: number[], playerCount: number, maxGroupSize: number, members = palletGroup) {
  return {
    playerIndices: async () => indices,
    groupMembers: async (_round: number, ownIndex: number) =>
      members(ownIndex, playerCount, maxGroupSize).map((index) => ({ index, player: { type: "Account", value: `player ${index}` } })),
  } as unknown as GameEngine;
}

// The pallet rejects a round whose vote count differs from the reporter's co-players that round
// (`InvalidReport`), so a bot's report has to follow the pallet's groups, short last groups included.
describe("buildReport", () => {
  for (const [playerCount, maxGroupSize] of [
    [10, 6],
    [24, 6],
    [301, 6],
    [5, 6],
  ]) {
    it(`votes Person once per co-player of each round, ${playerCount} players in groups of ${maxGroupSize}`, async () => {
      const indices = [3 % playerCount, (playerCount - 1) % playerCount];
      const report = await buildReport(rosterEngine(indices, playerCount, maxGroupSize), player, playerCount, maxGroupSize);
      expect(report).toEqual(indices.map((index) => Array(palletGroup(index, playerCount, maxGroupSize).length - 1).fill("Person")));
    });
  }

  it("builds no report for a player the roster doesn't seat", async () => {
    const engine = { playerIndices: async () => undefined } as unknown as GameEngine;
    expect(await buildReport(engine, player, 10, 6)).toBeUndefined();
  });

  // The app's game view shows nothing for a group that reads back short, and polls again.
  it("builds no report when a group reads back without one of its members", async () => {
    const short = (index: number, playerCount: number, maxGroupSize: number) => palletGroup(index, playerCount, maxGroupSize).slice(1);
    expect(await buildReport(rosterEngine([3, 4], 10, 6, short), player, 10, 6)).toBeUndefined();
  });
});
