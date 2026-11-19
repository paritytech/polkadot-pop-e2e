/** A game as the Jollity app plays it, and the negotiation one link carries through the statement store. */
export interface SignallingProfile {
  name: string;
  /** Players per group: each player negotiates a link with every other member. */
  groupSize: number;
  rounds: number;
  /** The room opens this long before the first round (the app's pre-connect), and the links to
   *  every co-player of every round are negotiated then. */
  preconnectMs: number;
  roundMs: number;
  breakMs: number;
  /** SDP of the data-channel-only description each side of a link sends, and the ICE candidates
   *  it trickles after it. */
  descriptionBytes: number;
  candidates: number;
}

// Chrome's data-channel-only offer is about 1 KB of SDP, and its 8 gathered candidates about
// 1.7 KB of JSON. The video offer goes down the data channel once it is open, not through the store.
export const PROFILES: Record<string, SignallingProfile> = {
  jollity: {
    name: "jollity",
    groupSize: 6,
    rounds: 2,
    preconnectMs: 64_000,
    roundMs: 6 * 12_000,
    breakMs: 7_000,
    descriptionBytes: 1_000,
    candidates: 8,
  },
};

/** The game's play: every round and the breaks between them. */
export function playMs(profile: SignallingProfile): number {
  return profile.rounds * profile.roundMs + (profile.rounds - 1) * profile.breakMs;
}

/** The room's life: the pre-connect, then the game's play. */
export function gameMs(profile: SignallingProfile): number {
  return profile.preconnectMs + playMs(profile);
}

/**
 * How a room's statements line up in time. `sync` is the app: every player opens the room at the
 * same instant, so the transport's heartbeats beat together. `random` opens each player's room
 * up to one heartbeat later, as phones whose rooms open at different moments would.
 */
export type Phase = "sync" | "random";
export const PHASES: Phase[] = ["sync", "random"];

/** The statement transport's heartbeat period. */
const HEARTBEAT_MS = 8_000;

/** When a player opens the room that opens at `openAt` for everyone in `sync`. */
export function roomOpensAt(phase: Phase, openAt: number): number {
  return phase === "sync" ? openAt : openAt + Math.random() * HEARTBEAT_MS;
}
