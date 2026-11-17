// The chain command signs up bot `index` as product account `index % ghostsPerHost` of host
// `index / ghostsPerHost`. A process that signs with another account sends statements the chain
// rejects, and a bot left out of every process never plays: either wastes a scheduled game.
import { describe, expect, it } from "vitest";
import { shardProcesses } from "./host.js";

describe("shardProcesses", () => {
  it.each([1, 3, 10, 25])("runs every bot once, as its signed-up account, with %i bots per process", (botsPerProcess) => {
    const ghostsPerHost = 10;
    const bots: number[] = [];
    for (const index of [0, 1, 2]) {
      for (const owned of shardProcesses(47, ghostsPerHost, botsPerProcess, { index, count: 3 })) {
        expect(owned.ghosts).toBeLessThanOrEqual(botsPerProcess);
        for (let ghost = 0; ghost < owned.ghosts; ghost++) {
          const bot = owned.firstPlayer + ghost;
          expect(Math.floor(bot / ghostsPerHost)).toBe(owned.host);
          expect(bot % ghostsPerHost).toBe(owned.firstAccount + ghost);
          bots.push(bot);
        }
      }
    }
    expect(bots.sort((left, right) => left - right)).toEqual(Array.from({ length: 47 }, (_, index) => index));
  });
});
