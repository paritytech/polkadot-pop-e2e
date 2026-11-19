import { p256 } from "@noble/curves/nist.js";
import { toHex } from "@jollity/statement-core";
import type { GameEngine } from "@jollity/protocol/src/engine";
import { describe, expect, it } from "vitest";
import { readChainSeats } from "./chain-seats.js";
import { communicationIdentifier, derivePlayer } from "./keys.js";

const [bot, otherBot, person] = [0, 1, 2].map((index) => derivePlayer("seats-test", index));
const registered = p256.getPublicKey(p256.utils.randomSecretKey(), false);

// Seats by round and player index, in groups of index pairs [0, 1] and [2].
const seating = [
  [bot, person, otherBot],
  [otherBot, bot, person],
];
const indices = new Map([
  [bot.address, [0, 1]],
  [otherBot.address, [2, 0]],
  [person.address, [1, 2]],
]);

const engine = {
  game: async () => ({ index: 7, max_group_size: 2, state: { type: "Reporting", value: { player_count: 3 } } }),
  playerIndices: async (address: string) => indices.get(address),
  groupMembers: async (round: number, ownIndex: number) =>
    (ownIndex < 2 ? [0, 1] : [2]).map((index) => ({ index, player: { type: "Account", value: seating[round][index].address } })),
  communicationIdentifier: async (address: string) =>
    address === person.address ? registered : communicationIdentifier([bot, otherBot].find((player) => player.address === address)!.publicKey),
} as unknown as GameEngine;

// Real players sign up through the app with keys of their own and sit at the bots' tables: a bot
// links to them only when its rooms follow the chain's groups and it seals to their registered keys.
describe("readChainSeats", () => {
  it("seats each bot with its chain co-players, a real player included, and reads their registered identifiers", async () => {
    const seats = await readChainSeats(engine, 7, [bot.address, otherBot.address], Date.now() + 10_000);
    expect(seats.rounds).toEqual({ [bot.address]: [[person.address], [otherBot.address]], [otherBot.address]: [[], [bot.address]] });
    expect(seats.identifiers[person.address]).toBe(toHex(registered));
    expect(seats.identifiers[person.address]).not.toBe(toHex(communicationIdentifier(person.publicKey)));
  });

  it("fails when the game shows no groups in time", async () => {
    const unseated = { ...engine, game: async () => ({ index: 7, max_group_size: 2, state: { type: "Registration", value: {} } }) } as unknown as GameEngine;
    await expect(readChainSeats(unseated, 7, [bot.address], Date.now())).rejects.toThrow("game 7 shows no groups");
  });
});
