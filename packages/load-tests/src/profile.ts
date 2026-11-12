/** How one player of a game uses the statement store for signalling. */
export interface SignallingProfile {
  name: string;
  /** Players per group: each player negotiates a link with every other member. */
  groupSize: number;
  rounds: number;
  /** The room opens this long before the first round, for every player at the same instant (the
   *  app's pre-connect), and the links to every co-player of every round are negotiated then. */
  preconnectMs: number;
  roundMs: number;
  breakMs: number;
  /** Bundle period while a round's links are being negotiated, and once they are up. */
  connectingIntervalMs: number;
  linkedIntervalMs: number;
  /** Time from the room's opening until every link is up. */
  connectingMs: number;
  ttlSeconds: number;
  maxInflight: number;
  submitTimeoutMs: number;
  /** Bundle bytes: the hello alone, and per co-player while connecting a sealed description and candidates. */
  helloBytes: number;
  descriptionBytes: number;
  candidateBytes: number;
}

// Rates and limits are the app's statement transport constants. A sealed field is base64 of
// AES-GCM over the plaintext. The store carries only the first, data-channel-only negotiation:
// Chrome's offer is about 1 KB of SDP (~1.4 KB sealed), its 8 gathered candidates about 1.7 KB of
// JSON (~2.3 KB sealed); the video offer goes down the data channel once it is open, not through
// the store. The room opens 64 s before the first round (the pre-connect), every player's at once.
export const PROFILES: Record<string, SignallingProfile> = {
  jollity: {
    name: "jollity",
    groupSize: 6,
    rounds: 2,
    preconnectMs: 64_000,
    roundMs: 6 * 12_000,
    breakMs: 7_000,
    connectingIntervalMs: 8_000,
    linkedIntervalMs: 16_000,
    connectingMs: 20_000,
    ttlSeconds: 30,
    maxInflight: 2,
    submitTimeoutMs: 12_000,
    helloBytes: 300,
    descriptionBytes: 1_400,
    candidateBytes: 2_300,
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

/** Whether `elapsedMs` after the room opened falls in the links' negotiation. */
export function isConnecting(profile: SignallingProfile, elapsedMs: number): boolean {
  return elapsedMs < profile.connectingMs;
}

/** A player's co-players over the game: its group in every round. */
export function coPlayers(profile: SignallingProfile): number {
  return profile.rounds * (profile.groupSize - 1);
}

export function bundleBytes(profile: SignallingProfile, connecting: boolean): number {
  return profile.helloBytes + (connecting ? coPlayers(profile) * (profile.descriptionBytes + profile.candidateBytes) : 0);
}

/**
 * How a room's bundles line up in time. `sync` is the app: every player opens the room at the same
 * instant and re-sends on a fixed beat from it, so a room's re-sends land in the same second.
 * `random` gives each player its own phase, as an app with jittered re-sends would.
 */
export type Phase = "sync" | "random";
export const PHASES: Phase[] = ["sync", "random"];

/** When a player that joined at `joinedAt` sends its first bundle, the room opening at `openAt`. */
export function firstSendAt(profile: SignallingProfile, phase: Phase, openAt: number, joinedAt: number): number {
  const opened = Math.max(openAt, joinedAt);
  return phase === "sync" ? opened : opened + Math.random() * profile.connectingIntervalMs;
}

/** When the bundle after one sent at `sentAt` goes: on the room's beat from `openAt` in `sync`. */
export function nextSendAt(profile: SignallingProfile, phase: Phase, openAt: number, sentAt: number, connecting: boolean): number {
  const period = connecting ? profile.connectingIntervalMs : profile.linkedIntervalMs;
  if (phase === "random") return sentAt + period;
  return openAt + (Math.floor((sentAt - openAt) / period) + 1) * period;
}
