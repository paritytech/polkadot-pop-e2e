import type { SignallingProfile } from "./profile.js";
import { topicOf, type Hex } from "./statement.js";

/**
 * How a game's signalling arrives at its players, as the Jollity app does it:
 * - `co-players`, the app since individuality-apps#1972 (21c243298): a phone posts under its own
 *   topic and subscribes to its co-players' topics, and a bundle with offers in it goes deflated;
 * - `game`, the app before that: one room topic that every phone posts under and subscribes to,
 *   next to its inbox, so every phone receives every bundle of the game.
 */
export const ROOMS = ["co-players", "game"] as const;
export type Rooms = (typeof ROOMS)[number];

export interface Seating {
  rooms: Rooms;
  players: number;
}

/** Where one player's bundles go and where it listens, and how many others receive each bundle. */
export interface Seat {
  post: Hex[];
  listen: Hex[];
  recipients: number;
  /** Bundles of `DEFLATE_FROM_BYTES` or more go deflated. */
  deflate: boolean;
}

/** The app deflates a bundle this long or longer; a hello alone stays plain. */
const DEFLATE_FROM_BYTES = 1_024;
/** What deflating leaves of a bundle for 10 co-players: about 45% smaller, per individuality-apps#1972. */
const DEFLATED_SHARE = 0.55;

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

/** The players `index` shares a table with in any round. */
function coPlayersOf(index: number, players: number, profile: SignallingProfile): number[] {
  const rounds = Array.from({ length: profile.rounds }, (_, round) => round);
  const tables = rounds.map((round) => tableOf(index, round, players, profile.groupSize));
  return Array.from({ length: players }, (_, other) => other).filter(
    (other) => other !== index && rounds.some((round) => tableOf(other, round, players, profile.groupSize) === tables[round]),
  );
}

export function seatOf(namespace: string, seating: Seating, profile: SignallingProfile, index: number): Seat {
  if (seating.rooms === "game") {
    const room = topicOf(`${namespace}/room`);
    return { post: [room], listen: [topicOf(`${namespace}/inbox/${index}`), room], recipients: seating.players - 1, deflate: false };
  }
  const coPlayers = coPlayersOf(index, seating.players, profile);
  return {
    post: [topicOf(`${namespace}/from/${index}`)],
    listen: coPlayers.map((other) => topicOf(`${namespace}/from/${other}`)),
    recipients: coPlayers.length,
    deflate: true,
  };
}

/** The bytes a bundle of `bytes` takes on the wire from `seat`. */
export function wireBytes(seat: Seat, bytes: number): number {
  return seat.deflate && bytes >= DEFLATE_FROM_BYTES ? Math.round(bytes * DEFLATED_SHARE) : bytes;
}
