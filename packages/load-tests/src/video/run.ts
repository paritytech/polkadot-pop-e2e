import type { TurnServer } from "@jollity/protocol";
import type { SignallingProfile } from "../profile.js";
import { roundsOf } from "../seating.js";
import { loadClip, type Clip } from "./clip.js";
import type { IceSetup } from "./ice.js";
import type { BotVideo } from "./mesh.js";
import type { VideoStats } from "./stats.js";
import type { TurnPasses } from "./turn.js";

/** A run's ICE settings, the same for every bot: each bot's TURN servers come from its own pass. */
export type RunIce = Omit<IceSetup, "turn">;

/** How a run's bots play video. */
export interface VideoRun {
  ice: RunIce;
  /** The lite bots' TURN passes by player index; without lite bots, STUN only. */
  turn?: TurnPasses;
}

/** A step's video: the run's ICE settings and the shard's counts. */
export interface VideoRoom {
  ice: RunIce;
  stats: VideoStats;
}

let clip: Clip | undefined;

/**
 * Player `index`'s video in a game of `players` whose room opens at `roomOpenAt`: each round's
 * table mates by account, and its ICE servers with its TURN servers, if it has a pass.
 */
export function botVideo(
  room: VideoRoom,
  seat: { index: number; players: number; profile: SignallingProfile; roomOpenAt: number },
  addressOf: (index: number) => string,
  turn: TurnServer[],
): BotVideo {
  return {
    rounds: roundsOf(seat.index, seat.players, seat.profile, seat.roomOpenAt).map(({ activeFrom, group }) => ({ activeFrom, group: group.map(addressOf) })),
    clip: (clip ??= loadClip()),
    ice: { ...room.ice, turn },
    stats: room.stats,
  };
}
