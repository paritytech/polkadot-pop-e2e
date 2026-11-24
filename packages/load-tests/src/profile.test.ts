import { describe, expect, it } from "vitest";
import { gameMs, playMs, PROFILES, roomOpensAt } from "./profile.js";
import { iceCandidates, iceCredentials, sessionDescription } from "./sdp.js";

const jollity = PROFILES.jollity;

describe("jollity profile", () => {
  it("counts the pre-connect in the room's life but not in the game's play", () => {
    expect(gameMs(jollity)).toBe(jollity.preconnectMs + playMs(jollity));
    expect(playMs(jollity)).toBe(2 * 72_000 + 7_000);
  });

  // What a link puts through the store is most of what a bot sends while its room negotiates:
  // a smaller description or fewer candidates would understate the load phones put on the store.
  it("negotiates a link with Chrome's description and candidates", () => {
    const credentials = iceCredentials();
    const description = sessionDescription("offer", credentials, jollity.descriptionBytes).sdp!;
    expect(description.length).toBeGreaterThanOrEqual(jollity.descriptionBytes);
    expect(description.length).toBeLessThan(jollity.descriptionBytes + 200);
    const candidatesBytes = iceCandidates(credentials, jollity.candidates).reduce((sum, candidate) => sum + JSON.stringify(candidate).length, 0);
    expect(candidatesBytes).toBeGreaterThan(1_500);
    expect(candidatesBytes).toBeLessThan(2_000);
  });
});

// The app opens every player's room at the pre-connect, so their heartbeats beat together.
describe("roomOpensAt", () => {
  const openAt = 1_000_000;

  it("opens every room at the same instant in sync", () => {
    expect(roomOpensAt("sync", openAt)).toBe(openAt);
  });

  it("spreads the rooms over one heartbeat in random", () => {
    const opened = roomOpensAt("random", openAt);
    expect(opened).toBeGreaterThanOrEqual(openAt);
    expect(opened).toBeLessThan(openAt + 8_000);
  });
});
