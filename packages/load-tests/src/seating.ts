import type { SignallingProfile } from "./profile.js";
import { topicOf, type Hex } from "./statement.js";

/**
 * Where a player's bundles go: `game`, one room for the whole game, as the app does, so every
 * player receives every bundle; `tables`, one topic per table of each round, so a player receives
 * only its co-players' bundles.
 */
export const ROOMS = ["game", "tables"] as const;
export type Rooms = (typeof ROOMS)[number];

export interface Seating {
  rooms: Rooms;
  players: number;
}

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

/** The topics player `index` listens to and posts its bundles on, and how many others receive them. */
export function seatOf(namespace: string, seating: Seating, profile: SignallingProfile, index: number): { topics: Hex[]; recipients: number } {
  if (seating.rooms === "game") return { topics: [topicOf(`${namespace}/room`)], recipients: seating.players - 1 };
  const rounds = Array.from({ length: profile.rounds }, (_, round) => round);
  const tables = rounds.map((round) => tableOf(index, round, seating.players, profile.groupSize));
  let recipients = 0;
  for (let other = 0; other < seating.players; other++) {
    if (other !== index && rounds.some((round) => tableOf(other, round, seating.players, profile.groupSize) === tables[round])) recipients++;
  }
  return { topics: tables.map((table, round) => topicOf(`${namespace}/r${round}/t${table}`)), recipients };
}
