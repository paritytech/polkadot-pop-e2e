import { describe, expect, it } from "vitest";
import { PROFILES } from "./profile.js";
import { coPlayersOf } from "./seating.js";

const profile = PROFILES.jollity;
const rosters = (players: number) => Array.from({ length: players }, (_, index) => coPlayersOf(index, players, profile));

// A sender counts each statement as due to every player on its roster, and a player listens to
// its roster's topics: a roster that is not mutual reads as loss on a healthy target, or hides it.
describe("coPlayersOf", () => {
  for (const players of [7, 36, 301]) {
    it(`gives every player a roster that lists it back, ${players} players`, () => {
      const all = rosters(players);
      all.forEach((roster, index) => {
        for (const other of roster) expect(all[other]).toContain(index);
      });
    });
  }

  // Two rounds at tables of 6, as the app plays: each player meets 10 different co-players, so a
  // table never seats more than 6 and no pair meets twice.
  it("gives every player 10 different co-players when the tables fill", () => {
    for (const roster of rosters(300)) expect(roster).toHaveLength(2 * (profile.groupSize - 1));
  });
});
