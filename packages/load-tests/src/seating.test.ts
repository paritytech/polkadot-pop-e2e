import { describe, expect, it } from "vitest";
import { PROFILES } from "./profile.js";
import { seatOf, wireBytes, type Rooms } from "./seating.js";

const profile = PROFILES.jollity;
const seats = (rooms: Rooms, players: number) => Array.from({ length: players }, (_, index) => seatOf("n", { rooms, players }, profile, index));

// The loss a step reports divides deliveries by the recipients each sender counts, so a count that
// disagrees with who actually listens reads as loss on a healthy target, or hides it.
describe("seatOf", () => {
  for (const rooms of ["co-players", "game"] as const) {
    for (const players of [7, 36, 301]) {
      it(`counts as recipients exactly the others listening on a sender's topics, ${rooms}, ${players} players`, () => {
        const all = seats(rooms, players);
        all.forEach((seat, sender) => {
          const listeners = all.filter((other, index) => index !== sender && other.listen.some((topic) => seat.post.includes(topic)));
          expect(seat.recipients).toBe(listeners.length);
        });
      });
    }
  }

  // Two rounds at tables of 6, as the app plays: each player meets 10 different co-players, so a
  // table never seats more than 6 and no pair meets twice.
  it("gives every player 10 different co-players when the tables fill", () => {
    for (const seat of seats("co-players", 300)) expect(seat.recipients).toBe(2 * (profile.groupSize - 1));
  });
});

// The app deflates a bundle that carries offers and leaves a hello alone plain; getting either
// wrong changes the bytes every bot pushes through the RPC by about half.
describe("wireBytes", () => {
  const [coPlayers] = seats("co-players", 36);
  const [game] = seats("game", 36);
  it("shrinks only the app's bundles with offers in them", () => {
    expect(wireBytes(coPlayers, 1_023)).toBe(1_023);
    expect(wireBytes(coPlayers, 20_000)).toBeLessThan(20_000);
    expect(wireBytes(game, 20_000)).toBe(20_000);
  });
});
