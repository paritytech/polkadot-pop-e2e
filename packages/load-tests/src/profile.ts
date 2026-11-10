/** How one player of a game uses the statement store for signalling. */
export interface SignallingProfile {
  name: string;
  /** Players per group: each player negotiates a link with every other member. */
  groupSize: number;
  rounds: number;
  roundMs: number;
  breakMs: number;
  /** Bundle period while a round's links are being negotiated, and once they are up. */
  connectingIntervalMs: number;
  linkedIntervalMs: number;
  /** Time from a round's start until its links are up. */
  connectingMs: number;
  ttlSeconds: number;
  maxInflight: number;
  submitTimeoutMs: number;
  /** Bundle bytes: the hello alone, and per peer while connecting a sealed description and candidates. */
  helloBytes: number;
  descriptionBytes: number;
  candidateBytes: number;
}

// Rates and limits are the app's statement transport constants. A sealed field is base64 of
// AES-GCM over the plaintext: a Chrome video + data-channel offer is about 4.9 KB of SDP and
// its 8 gathered candidates about 1.7 KB of JSON, so ~6.6 KB and ~2.3 KB sealed.
export const PROFILES: Record<string, SignallingProfile> = {
  jollity: {
    name: "jollity",
    groupSize: 6,
    rounds: 2,
    roundMs: 6 * 12_000,
    breakMs: 7_000,
    connectingIntervalMs: 8_000,
    linkedIntervalMs: 16_000,
    connectingMs: 20_000,
    ttlSeconds: 30,
    maxInflight: 2,
    submitTimeoutMs: 12_000,
    helloBytes: 300,
    descriptionBytes: 6_600,
    candidateBytes: 2_300,
  },
};

/** The game's length: every round and the breaks between them. */
export function gameMs(profile: SignallingProfile): number {
  return profile.rounds * profile.roundMs + (profile.rounds - 1) * profile.breakMs;
}

/** Whether `elapsedMs` into the game falls in a round's link negotiation. */
export function isConnecting(profile: SignallingProfile, elapsedMs: number): boolean {
  const intoRound = elapsedMs % (profile.roundMs + profile.breakMs);
  return intoRound < profile.connectingMs;
}

export function bundleBytes(profile: SignallingProfile, connecting: boolean): number {
  const peers = profile.groupSize - 1;
  return profile.helloBytes + (connecting ? peers * (profile.descriptionBytes + profile.candidateBytes) : 0);
}
