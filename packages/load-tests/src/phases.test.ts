import { describe, expect, it } from "vitest";
import type { BlockLoad } from "./block-load.js";
import type { BurstSummary } from "./burst.js";
import { findBlockLimits, summarizeGameProcessing, summarizePhases } from "./phases.js";

const GAME = 7;

function block(number: number, state: string | null, changes: Partial<BlockLoad> = {}): BlockLoad {
  return {
    number,
    timestamp: number * 6_000,
    arrivalTime: number * 6_000,
    extrinsics: 2,
    bytes: 500,
    normal: { refTime: 0.1, proofSize: 0.05 },
    mandatory: { refTime: 0.02, proofSize: 0.01 },
    stepShare: null,
    game: state === null ? null : { index: GAME, state },
    failures: {},
    gameEvents: {},
    creditTrees: 0,
    unincluded: 1,
    finalityLag: 2,
    witnessBytes: null,
    ...changes,
  };
}

/** Blocks 100–119: waiting, registration, shuffle steps, its wait for the game date, reporting, processing, then no game. */
function gameBlocks(changes: Record<number, Partial<BlockLoad>> = {}): BlockLoad[] {
  const states = [
    ...Array(3).fill(null),
    ...Array(3).fill("Registration"),
    "Shuffle.Step1Insert",
    "Shuffle.Step2Retrieve",
    ...Array(2).fill("Shuffle.Step4AwaitSession"),
    ...Array(4).fill("Reporting"),
    ...Array(2).fill("PlayerProcess.Step1ProcessPlayers"),
    ...Array(4).fill(null),
  ];
  return states.map((state, position) => block(100 + position, state, changes[100 + position]));
}

function burst(firstBlock: number, lastBlock: number): BurstSummary {
  return {
    submitted: 1,
    ok: 1,
    failures: {},
    inTime: 1,
    firstBlock,
    lastBlock,
    durationMs: 0,
    inclusionMs: { count: 1, p50: 1, p95: 1, max: 1, p99: 1 },
  };
}

function limits(blocks: BlockLoad[], reportEnds = 10_000) {
  return findBlockLimits({
    blocks,
    game: { index: GAME, gamePlayTime: 0, registrationEnds: 0, reportEnds },
    phases: { registration: 0, shuffle: 0, post_shuffle_margin: 0, reporting: 0, player_process: 60 },
    signUp: burst(103, 105),
    report: burst(110, 113),
  });
}

// Each row has to show what the chain did while the game was in that state, so the block that
// ends a state counts with it, and the hours before the game and the blocks after it don't count.
describe("summarizePhases", () => {
  it("splits the game's blocks where its state changes", () => {
    const blocks = gameBlocks({ 116: { gameEvents: { GameEnded: 1 } } });
    const phases = summarizePhases({ blocks, game: { index: GAME, gamePlayTime: 0, registrationEnds: 0, reportEnds: 0 }, proposals: null });
    expect(phases.map(({ phase, firstBlock, lastBlock }) => [phase, firstBlock, lastBlock])).toEqual([
      ["Registration", 104, 106],
      ["Shuffle", 107, 110],
      ["Reporting", 111, 114],
      ["PlayerProcess", 115, 116],
    ]);
  });

  it("leaves out blocks of another game", () => {
    const blocks = gameBlocks().map((load) => (load.number < 105 && load.game ? { ...load, game: { index: GAME - 1, state: "Reporting" } } : load));
    expect(summarizePhases({ blocks, game: { index: GAME, gamePlayTime: 0, registrationEnds: 0, reportEnds: 0 }, proposals: null })[0]).toMatchObject({
      phase: "Registration",
      firstBlock: 106,
    });
  });
});

describe("summarizeGameProcessing", () => {
  const game = { index: GAME, gamePlayTime: 0, registrationEnds: 0, reportEnds: 0 };

  // The shuffle waits for the game date once its work is done; counting that wait would hide how
  // long the work itself took.
  it("counts the shuffle's work without its wait, and player processing from the report end to GameEnded", () => {
    const blocks = gameBlocks({ 116: { gameEvents: { GameEnded: 1 } } });
    expect(summarizeGameProcessing({ blocks, game })).toMatchObject({
      shuffle: { blocks: 2, ms: 12_000 },
      playerProcess: { reportEndBlock: 114, gameEndBlock: 116, blocks: 2, ms: 12_000 },
    });
  });

  it("takes the heaviest step from step calls where the runtime has them", () => {
    const blocks = gameBlocks({ 108: { stepShare: 0.7 }, 115: { stepShare: 0.4, mandatory: { refTime: 0.9, proofSize: 0 } } });
    expect(summarizeGameProcessing({ blocks, game }).heaviestStep).toEqual({ share: 0.7, block: 108, source: "step call" });
  });

  // Without step calls the steps run in the runtime's hooks, which count as mandatory weight; the
  // shuffle's wait for the game date does no step work, so its blocks don't count.
  it("falls back to mandatory weight of the processing blocks without step calls", () => {
    const blocks = gameBlocks({ 109: { mandatory: { refTime: 0.9, proofSize: 0 } }, 115: { mandatory: { refTime: 0.3, proofSize: 0 } } });
    expect(summarizeGameProcessing({ blocks, game }).heaviestStep).toEqual({ share: 0.3, block: 115, source: "mandatory weight" });
  });
});

describe("findBlockLimits", () => {
  it("finds nothing when blocks stay within limits", () => {
    expect(limits(gameBlocks({ 116: { gameEvents: { GameEnded: 1 } } }))).toEqual({ findings: [], capacity: [] });
  });

  // A block that takes twice the usual time while a burst is in the pool shows where the chain
  // falls behind; it fails the run only through its effects, such as reports not in time.
  it("notes a burst block over twice the median block time without failing, not one just under", () => {
    const blocks = gameBlocks();
    for (const load of blocks.filter((load) => load.number >= 112)) load.arrivalTime! += 12_001;
    expect(limits(blocks)).toEqual({
      findings: [],
      capacity: [expect.stringMatching(/^report burst: 1 blocks took over twice the median block time of 6\.0 s, the longest 18\.0 s \(#112\)/)],
    });

    const justUnder = gameBlocks();
    for (const load of justUnder.filter((load) => load.number >= 112)) load.arrivalTime! += 6_000;
    expect(limits(justUnder).capacity).toEqual([]);
  });

  // A full block is the chain's capacity at work, not a failure: the transactions still get in.
  it("notes normal-class weight at 90% of its limit without failing", () => {
    expect(limits(gameBlocks({ 105: { normal: { refTime: 0.9, proofSize: 0.2 } } }))).toEqual({
      findings: [],
      capacity: [expect.stringMatching(/^normal-class weight at 90% or more in 1 blocks \(Registration 1\)/)],
    });
    expect(limits(gameBlocks({ 105: { normal: { refTime: 0.89, proofSize: 0.89 } } })).capacity).toEqual([]);
  });

  // 8 waiting trees is the pallet's limit, but the next block builds one and opens room again:
  // only a report whose credits don't fit fails, and the report burst counts that.
  it("notes credit trees at the pallet's limit of 8 without failing, not at 7", () => {
    expect(limits(gameBlocks({ 113: { creditTrees: 8 } }))).toEqual({
      findings: [],
      capacity: ["credit trees at the pallet's limit of 8 waiting after 1 blocks, from #113"],
    });
    expect(limits(gameBlocks({ 113: { creditTrees: 7 } })).capacity).toEqual([]);
  });

  // The game's schedule allows player processing `player_process` seconds after reports end; the
  // next game's registration assumes it is over by then.
  it("flags a game that ended after report end plus player_process", () => {
    // Block 116 is at 696 s; reports end at 600 s and processing has 60 s.
    expect(limits(gameBlocks({ 116: { gameEvents: { GameEnded: 1 } } }), 600).findings).toEqual(["game end: GameEnded at #116, 36.0 s after report end plus player_process"]);
    expect(limits(gameBlocks({ 116: { gameEvents: { GameEnded: 1 } } }), 636).findings).toEqual([]);
  });
});
