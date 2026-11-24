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

/** The players `index` shares a table with in any round: the roster its room links to. */
export function coPlayersOf(index: number, players: number, profile: SignallingProfile): number[] {
  const rounds = Array.from({ length: profile.rounds }, (_, round) => round);
  const tables = rounds.map((round) => tableOf(index, round, players, profile.groupSize));
  return Array.from({ length: players }, (_, other) => other).filter(
    (other) => other !== index && rounds.some((round) => tableOf(other, round, players, profile.groupSize) === tables[round]),
  );
}
