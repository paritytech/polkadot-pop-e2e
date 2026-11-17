import { describe, expect, it } from "vitest";
import { bundleBytes, firstSendAt, gameMs, isConnecting, nextSendAt, playMs, PROFILES } from "./profile.js";

const jollity = PROFILES.jollity;

// The app opens every player's room at the pre-connect and links every co-player of every round
// then; bundles re-send on one beat from that instant.
describe("jollity profile", () => {
  it("negotiates every co-player of every round in the pre-connect", () => {
    expect(isConnecting(jollity, 0)).toBe(true);
    expect(isConnecting(jollity, jollity.connectingMs)).toBe(false);
    expect(bundleBytes(jollity, true)).toBe(jollity.helloBytes + 10 * (jollity.descriptionBytes + jollity.candidateBytes));
    expect(bundleBytes(jollity, false)).toBe(jollity.helloBytes);
  });

  it("counts the pre-connect in the room's life but not in the game's play", () => {
    expect(gameMs(jollity)).toBe(jollity.preconnectMs + playMs(jollity));
    expect(playMs(jollity)).toBe(2 * 72_000 + 7_000);
  });
});

describe("sync phase", () => {
  const openAt = 1_000_000;

  it("sends every ghost's first bundle at the room's opening", () => {
    expect(firstSendAt(jollity, "sync", openAt, openAt - 25_000)).toBe(openAt);
    expect(firstSendAt(jollity, "sync", openAt, openAt + 3_000)).toBe(openAt + 3_000);
  });

  it("re-sends on the room's beat, however late a send went", () => {
    expect(nextSendAt(jollity, "sync", openAt, openAt, true)).toBe(openAt + 8_000);
    expect(nextSendAt(jollity, "sync", openAt, openAt + 8_400, true)).toBe(openAt + 16_000);
    expect(nextSendAt(jollity, "sync", openAt, openAt + 24_000, false)).toBe(openAt + 32_000);
  });

  // A ghost that joined before the room opened would otherwise send connecting bundles the app
  // never sends, and `random` would measure extra load instead of a spread-out burst.
  it("spreads the first sends over a period from the room's opening in random", () => {
    const first = firstSendAt(jollity, "random", openAt, openAt - 25_000);
    expect(first).toBeGreaterThanOrEqual(openAt);
    expect(first).toBeLessThan(openAt + jollity.connectingIntervalMs);
    expect(nextSendAt(jollity, "random", openAt, openAt + 3_100, true)).toBe(openAt + 11_100);
  });
});
