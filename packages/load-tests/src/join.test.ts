import type { PalletGame } from "@jollity/protocol/src/engine";
import { describe, expect, it } from "vitest";
import { pickGame, type GameCalendar } from "./join.js";

const now = 1_800_000_000;
const phases = { registration: 600, shuffle: 60, post_shuffle_margin: 30 };
const open = { index: 357, state: { type: "Registration", value: { next_player_index: 0 } }, game_date: now + 390, registration_ends: now + 300 } as unknown as PalletGame;
const calendar: GameCalendar = { game: open, schedules: [{ game_play_time: now + 3_600 }, { game_play_time: now + 7_200 }], phases, now };

// A run that can't sign its bots up before registration ends must say so before it binds or
// signs anything, and point at a game it can make, instead of missing the game hours later.
describe("pickGame", () => {
  it("takes the game in registration when its sign-ups fit before registration ends", () => {
    expect(pickGame(calendar, undefined, { bindMs: 0, signUpMs: 200_000 })).toEqual({
      index: 357,
      playsAt: now + 390,
      registrationEnds: now + 300,
      neededMs: 200_000,
    });
  });

  it("fails on a game the binds and sign-ups don't fit, naming the next game that fits", () => {
    expect(() => pickGame(calendar, undefined, { bindMs: 971_000, signUpMs: 200_000 })).toThrow(
      `game 357 at 2027-01-15 08:06:30 UTC: registration ends 2027-01-15 08:05:00 UTC, 300 s from now, and the run needs 1171 s (binds 971 s, sign-ups 200 s); the next game that fits is game 358 at 2027-01-15 09:00:00 UTC, --game-at ${now + 3_600}`,
    );
  });

  it("binds before a scheduled game opens registration, and signs up once it is open", () => {
    const plan = pickGame(calendar, now + 3_600, { bindMs: 971_000, signUpMs: 200_000 });
    expect(plan).toEqual({ index: 358, playsAt: now + 3_600, registrationEnds: now + 3_510, neededMs: (3_600 - 690) * 1000 + 200_000 });
  });
});
