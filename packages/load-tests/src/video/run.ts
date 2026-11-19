import type { TurnServer } from "@jollity/protocol";
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

let clip: Clip | undefined;

/** A bot's video over `rounds`, its groups by account, with the run's ICE settings and its TURN servers, if it has a pass. */
export function botVideo(ice: RunIce, turn: TurnServer[], stats: VideoStats, rounds: BotVideo["rounds"]): BotVideo {
  return {
    rounds,
    clip: (clip ??= loadClip()),
    ice: { ...ice, turn },
    stats,
  };
}
