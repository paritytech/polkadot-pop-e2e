import type { GameEngine, PalletGame } from "@jollity/protocol/src/engine";
import { describe, expect, it } from "vitest";
import { isFollowedGame, pickGame, planGame, type GameCalendar } from "./join.js";
import type { PeopleApi } from "./target.js";

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
      `game 357 at 2027-01-15 08:06:30 UTC: registration ends 2027-01-15 08:05:00 UTC, 300 s from now, and the run needs 1171 s (start-up 0 s, binds 971 s, sign-ups 200 s); the next game that fits is game 358 at 2027-01-15 09:00:00 UTC, --game-at ${now + 3_600}`,
    );
  });

  it("binds before a scheduled game opens registration, and signs up once it is open", () => {
    const plan = pickGame(calendar, now + 3_600, { bindMs: 971_000, signUpMs: 200_000 });
    expect(plan).toEqual({ index: 358, playsAt: now + 3_600, registrationEnds: now + 3_510, neededMs: (3_600 - 690) * 1000 + 200_000 });
  });

  // The plan job picks the game minutes before the chain job can sign up: game 173's sign-ups
  // fit when the plan checked them, and no longer did by the time the chain job started.
  it("counts the chain job's start-up before its sign-ups", () => {
    const lead = { bindMs: 0, signUpMs: 144_000 };
    expect(pickGame(calendar, undefined, lead).index).toBe(357);
    expect(() => pickGame(calendar, undefined, { ...lead, startMs: 300_000 })).toThrow("needs 444 s (start-up 300 s, binds 0 s, sign-ups 144 s); the next game that fits is game 358");
  });
});

// A scheduled game's registration ends shuffle and margin before it plays, by the durations the
// chain applies: a shuffle of 120 s ends it a minute earlier than the default 60 s.
describe("planGame", () => {
  const engine = { game: async () => undefined, schedules: async () => [{ game_play_time: now + 3_600 }], now: async () => now } as unknown as GameEngine;
  const apiWith = (stored: GameCalendar["phases"] | undefined) =>
    ({
      query: { Game: { StoredPhaseDurations: { getValue: async () => stored } } },
      constants: { Game: { DefaultPhaseDurations: async () => phases } },
    }) as unknown as PeopleApi;
  const lead = { bindMs: 0, signUpMs: 0 };

  it("ends a scheduled game's registration by the chain's stored phase durations", async () => {
    const plan = await planGame(engine, apiWith({ registration: 600, shuffle: 120, post_shuffle_margin: 30 }), undefined, lead);
    expect(plan.registrationEnds).toBe(now + 3_600 - 150);
  });

  it("falls back to the pallet's default phase durations", async () => {
    const plan = await planGame(engine, apiWith(undefined), undefined, lead);
    expect(plan.registrationEnds).toBe(now + 3_600 - 90);
  });
});

// The same lite bots play every run, so another run may have them signed up to an earlier game:
// a message machine that played that game would leave its own run's game without players.
describe("isFollowedGame", () => {
  const earlier = { ...open, index: 164, game_date: now + 600 } as PalletGame;
  const target = now + 3_000;

  it("skips a game its bots are signed up to that isn't the run's game", () => {
    expect(isFollowedGame(earlier, true, now, target)).toBe(false);
  });

  it("plays the run's game once its bots are signed up to it", () => {
    expect(isFollowedGame({ ...earlier, index: 165, game_date: target }, true, now, target)).toBe(true);
    expect(isFollowedGame({ ...earlier, index: 165, game_date: target }, false, now, target)).toBe(false);
  });

  it("without a target, plays the game its bots are signed up to", () => {
    expect(isFollowedGame(earlier, true, now, undefined)).toBe(true);
  });
});
