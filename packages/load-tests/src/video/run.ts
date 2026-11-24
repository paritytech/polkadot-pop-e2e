import type { TurnServer } from "@jollity/protocol";
import { loadClip, type Clip } from "./clip.js";
import type { IceSetup } from "./ice.js";
import type { BotVideo } from "./mesh.js";
import type { VideoGroup, VideoGroups } from "./stats.js";
import type { TurnPasses } from "./turn.js";

/** A run's ICE settings, the same for every bot: TURN servers and the relay-only policy depend on the bot's group. */
export type RunIce = Omit<IceSetup, "turn" | "relay">;

/** How many of a run's lite bots, from offset 0 of `--lite-from`, use TURN, and how many of those relay candidates only. */
export interface BotSplit {
  turnBots: number;
  relayBots: number;
}

/** The split of a run whose bots all use STUN only. */
export const STUN_ONLY: BotSplit = { turnBots: 0, relayBots: 0 };

/** How a run's bots play video. */
export interface VideoRun {
  ice: RunIce;
  split: BotSplit;
  /** The TURN passes of the bots that use TURN, by player index. */
  turn?: TurnPasses;
}

/** A bot's video setup in its group: its TURN servers are empty without a valid pass. */
export interface BotIce {
  group: VideoGroup;
  turn: TurnServer[];
}

function nonNegativeInteger(name: string, text: string): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) throw new Error(`--${name} must be a non-negative integer, not '${text}'`);
  return value;
}

/**
 * The split of `--turn-bots` (default every bot), `--relay-bots` (default none) and `--relay`
 * (every bot relay-only). Fails on a malformed count, on `--relay` with `--relay-bots`, and on
 * more relay-only bots than TURN bots, since a relay-only bot without TURN can't connect.
 */
export function parseBotSplit(options: { turnBots?: string; relayBots?: string; relay: boolean }): BotSplit {
  if (options.relay && options.relayBots !== undefined) throw new Error("--relay makes every bot relay-only: pass --relay or --relay-bots, not both");
  const turnBots = options.turnBots === undefined ? Infinity : nonNegativeInteger("turn-bots", options.turnBots);
  const relayBots = options.relay ? Infinity : options.relayBots === undefined ? 0 : nonNegativeInteger("relay-bots", options.relayBots);
  if (relayBots > turnBots) {
    const relayOnly = options.relay ? "--relay makes every bot relay-only" : `--relay-bots ${relayBots} makes ${relayBots} bots relay-only`;
    throw new Error(`${relayOnly}, but --turn-bots ${turnBots} gives TURN to fewer: a relay-only bot without TURN can't connect`);
  }
  return { turnBots, relayBots };
}

/** The group of lite bot `offset` from `--lite-from`. */
export function videoGroupOf(offset: number, split: BotSplit): VideoGroup {
  return offset < split.relayBots ? "relayOnly" : offset < split.turnBots ? "turnAndDirect" : "stunOnly";
}

/** Of lite bot `offsets`, the ones that use TURN, relay-only ones included: only these prove and ask the issuer for a pass. */
export function turnOffsetsOf(offsets: number[], split: BotSplit): number[] {
  return offsets.filter((offset) => videoGroupOf(offset, split) !== "stunOnly");
}

/** Lite bot `offset`'s group in `video` and its TURN servers: none in the STUN-only group or without a valid pass. */
export function botIceOf(video: VideoRun, offset: number): BotIce {
  const group = videoGroupOf(offset, video.split);
  return { group, turn: group === "stunOnly" ? [] : (video.turn?.serversOf(offset) ?? []) };
}

let clip: Clip | undefined;

/** A bot's video over `rounds`, its groups by account, with the run's ICE settings and its group's; it counts into its group of `stats`. */
export function botVideo(ice: RunIce, bot: BotIce, stats: VideoGroups, rounds: BotVideo["rounds"]): BotVideo {
  return {
    rounds,
    clip: (clip ??= loadClip()),
    ice: { ...ice, turn: bot.turn, relay: bot.group === "relayOnly" },
    stats: stats[bot.group],
  };
}
