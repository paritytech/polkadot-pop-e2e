import type { TurnServer } from "@jollity/protocol";
import { loadClip, type Clip } from "./clip.js";
import type { IceSetup } from "./ice.js";
import type { BotVideo } from "./mesh.js";
import type { VideoGroups } from "./stats.js";
import type { TurnPasses } from "./turn.js";

/** A run's ICE settings, the same for every bot: each bot's TURN servers come from its own pass. */
export type RunIce = Omit<IceSetup, "turn">;

/** How a run's bots play video. */
export interface VideoRun {
  ice: RunIce;
  /** The TURN passes of the lite bots that use TURN, by player index; the other bots use STUN only. */
  turn?: TurnPasses;
}

let clip: Clip | undefined;

/**
 * A bot's video over `rounds`, its groups by account, with the run's ICE settings. `turn` is null
 * for a bot that uses STUN only, else its TURN servers, empty without a valid pass; the bot counts
 * into the matching group of `stats`.
 */
export function botVideo(ice: RunIce, turn: TurnServer[] | null, stats: VideoGroups, rounds: BotVideo["rounds"]): BotVideo {
  return {
    rounds,
    clip: (clip ??= loadClip()),
    ice: { ...ice, turn: turn ?? [] },
    stats: turn ? stats.withTurn : stats.withoutTurn,
  };
}
