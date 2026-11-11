import { describe, expect, it } from "vitest";
import { PROFILES } from "./profile.js";
import { seatOf } from "./seating.js";

const profile = PROFILES.jollity;

// The loss a `tables` step reports divides deliveries by the recipients each sender counts, so a
// count that disagrees with who actually listens reads as loss on a healthy target, or hides it.
describe("seatOf with tables", () => {
  for (const players of [7, 36, 300, 301]) {
    it(`counts as recipients exactly the players listening on a sender's topics, ${players} players`, () => {
      const seats = Array.from({ length: players }, (_, index) => seatOf("n", { rooms: "tables", players }, profile, index));
      seats.forEach((seat, sender) => {
        const listeners = seats.filter((other, index) => index !== sender && other.topics.some((topic) => seat.topics.includes(topic)));
        expect(seat.recipients).toBe(listeners.length);
      });
    });

    it(`seats at most a group per table in every round, ${players} players`, () => {
      for (let round = 0; round < profile.rounds; round++) {
        const sizes = new Map<string, number>();
        for (let index = 0; index < players; index++) {
          const topic = seatOf("n", { rooms: "tables", players }, profile, index).topics[round];
          sizes.set(topic, (sizes.get(topic) ?? 0) + 1);
        }
        expect(Math.max(...sizes.values())).toBeLessThanOrEqual(profile.groupSize);
      }
    });
  }

  it("gives a player new co-players in the second round", () => {
    const players = 300;
    const seats = Array.from({ length: players }, (_, index) => seatOf("n", { rooms: "tables", players }, profile, index));
    const sharedBoth = seats.filter((seat, index) => seats.some((other, otherIndex) => otherIndex !== index && seat.topics.every((topic) => other.topics.includes(topic))));
    expect(sharedBoth.length).toBe(0);
  });
});
