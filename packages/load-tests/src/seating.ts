import type { SignallingProfile } from "./profile.js";

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/**
 * The table of `index` in `round`: players are dealt to tables of `groupSize` in an order that
 * differs per round, so a round's co-players are mostly new ones.
 */
function tableOf(index: number, round: number, players: number, groupSize: number): number {
  let stride = round === 0 ? 1 : groupSize * round + 1;
  while (greatestCommonDivisor(stride, players) !== 1) stride++;
  return Math.floor(((index * stride) % players) / groupSize);
}

/** The players `index` shares a table with in `round`. */
export function tableMatesOf(index: number, round: number, players: number, profile: SignallingProfile): number[] {
  const table = tableOf(index, round, players, profile.groupSize);
  return Array.from({ length: players }, (_, other) => other).filter((other) => other !== index && tableOf(other, round, players, profile.groupSize) === table);
}

/** The players `index` shares a table with in any round: the roster its room links to. */
export function coPlayersOf(index: number, players: number, profile: SignallingProfile): number[] {
  const mates = new Set(Array.from({ length: profile.rounds }, (_, round) => tableMatesOf(index, round, players, profile)).flat());
  return Array.from({ length: players }, (_, other) => other).filter((other) => mates.has(other));
}

/**
 * Each round's table mates of `index` in a room opened at `roomOpenAt`, with when the app turns the
 * camera to them: the first round's from the opening, a later round's when the round before ends.
 */
export function roundsOf(index: number, players: number, profile: SignallingProfile, roomOpenAt: number): Array<{ activeFrom: number; group: number[] }> {
  const firstRoundAt = roomOpenAt + profile.preconnectMs;
  return Array.from({ length: profile.rounds }, (_, round) => ({
    activeFrom: round === 0 ? roomOpenAt : firstRoundAt + round * profile.roundMs + (round - 1) * profile.breakMs,
    group: tableMatesOf(index, round, players, profile),
  }));
}
