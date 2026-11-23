import { MAX_CREDIT_TREES, type BlockLoad, type WeightShare } from "./block-load.js";
import type { ChainResult } from "./chain.js";
import { bump, total } from "./stats.js";

/** Normal-class share at which a block counts as full. */
const FULL_NORMAL_SHARE = 0.9;
/** Block time over this multiple of the game's median, during a burst, counts as a stall. */
const SLOW_BLOCK_FACTOR = 2;

/** Consecutive blocks that executed in one game state: the state after the block before each. */
export interface BlockWindow {
  state: string;
  blocks: BlockLoad[];
}

export interface PhaseLoad {
  phase: string;
  firstBlock: number;
  lastBlock: number;
  blocks: number;
  blockMs: { p50: number | null; max: number | null };
  maxExtrinsics: number;
  maxNormal: WeightShare;
  maxMandatory: WeightShare;
  maxBytes: number;
  maxWitnessBytes: number | null;
  maxUnincluded: number;
  maxCreditTrees: number;
  maxFinalityLag: number;
  failedExtrinsics: number;
  /** Collator 1's proposals in this phase's blocks, by how block building ended; null off previewnet. */
  proposalEnds: Record<string, number> | null;
}

export interface GameProcessing {
  /** The shuffle's work, its wait for the game date excluded. */
  shuffle: { blocks: number; ms: number } | null;
  /** From the last Reporting block to the block that ended the game. */
  playerProcess: { reportEndBlock: number; gameEndBlock: number | null; blocks: number; ms: number } | null;
  /** The heaviest step: its share of the step budget where the runtime runs steps as calls, else the mandatory class's share of a block's ref time. */
  heaviestStep: { share: number; block: number; source: "step call" | "mandatory weight" } | null;
}

function phaseOf(state: string): string {
  return state.split(".")[0];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function maxOf<T>(items: T[], value: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || value(item) > value(best) ? item : best), undefined);
}

/** Milliseconds since the previous block arrived, by block number, for each block whose previous block's arrival is known. */
function blockTimes(blocks: BlockLoad[]): Map<number, number> {
  const times = new Map<number, number>();
  for (const [position, block] of blocks.entries()) {
    const previous = blocks[position - 1];
    if (previous?.number === block.number - 1 && previous.arrivalTime !== null && block.arrivalTime !== null) {
      times.set(block.number, block.arrivalTime - previous.arrivalTime);
    }
  }
  return times;
}

/**
 * The blocks of game `gameIndex`, split where its state changes. A block belongs to the state it
 * executed in, so the block that ends a state, and the one that ends the game, count with it.
 */
export function splitStates(blocks: BlockLoad[], gameIndex: number): BlockWindow[] {
  const windows: BlockWindow[] = [];
  for (const [position, block] of blocks.entries()) {
    const previous = blocks[position - 1]?.game;
    if (previous?.index !== gameIndex) continue;
    const last = windows.at(-1);
    if (last?.state === previous.state) last.blocks.push(block);
    else windows.push({ state: previous.state, blocks: [block] });
  }
  return windows;
}

/** `windows` merged into one per phase, such as every Shuffle step into Shuffle. */
export function mergePhases(windows: BlockWindow[]): BlockWindow[] {
  const phases: BlockWindow[] = [];
  for (const { state, blocks } of windows) {
    const last = phases.at(-1);
    if (last?.state === phaseOf(state)) last.blocks.push(...blocks);
    else phases.push({ state: phaseOf(state), blocks: [...blocks] });
  }
  return phases;
}

export function summarizePhases(result: Pick<ChainResult, "blocks" | "game" | "proposals">): PhaseLoad[] {
  const times = blockTimes(result.blocks);
  return mergePhases(splitStates(result.blocks, result.game.index)).map(({ state, blocks }) => {
    const firstBlock = blocks[0].number;
    const lastBlock = blocks.at(-1)!.number;
    const blockMs = blocks.flatMap((block) => times.get(block.number) ?? []);
    const witness = blocks.flatMap((block) => block.witnessBytes ?? []);
    let proposalEnds: Record<string, number> | null = null;
    if (result.proposals) {
      proposalEnds = {};
      for (const proposal of result.proposals) {
        if (proposal.number >= firstBlock && proposal.number <= lastBlock) bump(proposalEnds, proposal.end);
      }
    }
    const max = (value: (block: BlockLoad) => number) => Math.max(...blocks.map(value));
    return {
      phase: state,
      firstBlock,
      lastBlock,
      blocks: blocks.length,
      blockMs: { p50: median(blockMs), max: blockMs.length > 0 ? Math.max(...blockMs) : null },
      maxExtrinsics: max((block) => block.extrinsics),
      maxNormal: { refTime: max((block) => block.normal.refTime), proofSize: max((block) => block.normal.proofSize) },
      maxMandatory: { refTime: max((block) => block.mandatory.refTime), proofSize: max((block) => block.mandatory.proofSize) },
      maxBytes: max((block) => block.bytes),
      maxWitnessBytes: witness.length > 0 ? Math.max(...witness) : null,
      maxUnincluded: max((block) => block.unincluded),
      maxCreditTrees: max((block) => block.creditTrees),
      maxFinalityLag: max((block) => block.finalityLag),
      failedExtrinsics: blocks.reduce((sum, block) => sum + total(block.failures), 0),
      proposalEnds,
    };
  });
}

function blockSpan(blocks: BlockLoad[], times: Map<number, number>): { blocks: number; ms: number } {
  return { blocks: blocks.length, ms: blocks.reduce((sum, block) => sum + (times.get(block.number) ?? 0), 0) };
}

export function summarizeGameProcessing(result: Pick<ChainResult, "blocks" | "game">): GameProcessing {
  const times = blockTimes(result.blocks);
  const windows = splitStates(result.blocks, result.game.index);
  const shuffleWork = windows.filter(({ state }) => phaseOf(state) === "Shuffle" && state !== "Shuffle.Step4AwaitSession").flatMap(({ blocks }) => blocks);
  const playerProcess = mergePhases(windows).find(({ state }) => state === "PlayerProcess")?.blocks ?? [];
  const processing = [...shuffleWork, ...playerProcess];
  const heaviestCall = maxOf(
    windows.flatMap(({ blocks }) => blocks).filter((block) => block.stepShare !== null),
    (block) => block.stepShare!,
  );
  const heaviestMandatory = maxOf(processing, (block) => block.mandatory.refTime);
  return {
    shuffle: shuffleWork.length > 0 ? blockSpan(shuffleWork, times) : null,
    playerProcess:
      playerProcess.length > 0
        ? {
            reportEndBlock: playerProcess[0].number - 1,
            gameEndBlock: playerProcess.find((block) => block.gameEvents.GameEnded)?.number ?? null,
            ...blockSpan(playerProcess, times),
          }
        : null,
    heaviestStep: heaviestCall
      ? { share: heaviestCall.stepShare!, block: heaviestCall.number, source: "step call" }
      : heaviestMandatory
        ? { share: heaviestMandatory.mandatory.refTime, block: heaviestMandatory.number, source: "mandatory weight" }
        : null,
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export interface BlockLimits {
  /** Effects on the game that fail the run: a game end later than its schedule allows. Rejected reports are the report burst's findings. */
  findings: string[];
  /** Where blocks came close to their limits without failing anything: slow blocks in a burst, full blocks, credit trees at the pallet's limit. */
  capacity: string[];
}

export function findBlockLimits(result: Pick<ChainResult, "blocks" | "game" | "phases" | "signUp" | "report">): BlockLimits {
  const findings: string[] = [];
  const capacity: string[] = [];
  const times = blockTimes(result.blocks);
  const windows = splitStates(result.blocks, result.game.index);
  const gameBlocks = windows.flatMap(({ blocks }) => blocks);
  const typicalMs = median(gameBlocks.flatMap((block) => times.get(block.number) ?? []));

  for (const [name, burst] of [
    ["sign-up", result.signUp],
    ["report", result.report],
  ] as const) {
    if (!burst || burst.firstBlock === null || burst.lastBlock === null || typicalMs === null) continue;
    const slow = gameBlocks.filter(
      (block) => block.number >= burst.firstBlock! && block.number <= burst.lastBlock! && (times.get(block.number) ?? 0) > SLOW_BLOCK_FACTOR * typicalMs,
    );
    const slowest = maxOf(slow, (block) => times.get(block.number)!);
    if (slowest) {
      capacity.push(
        `${name} burst: ${slow.length} blocks took over twice the median block time of ${seconds(typicalMs)}, the longest ${seconds(times.get(slowest.number)!)} (#${slowest.number})`,
      );
    }
  }

  const full = windows.flatMap(({ state, blocks }) =>
    blocks.filter((block) => Math.max(block.normal.refTime, block.normal.proofSize) >= FULL_NORMAL_SHARE).map((block) => ({ phase: phaseOf(state), block })),
  );
  if (full.length > 0) {
    const byPhase: Record<string, number> = {};
    for (const { phase } of full) bump(byPhase, phase);
    const fullest = maxOf(full, ({ block }) => Math.max(block.normal.refTime, block.normal.proofSize))!.block;
    capacity.push(
      `normal-class weight at ${percent(FULL_NORMAL_SHARE)} or more in ${full.length} blocks (${Object.entries(byPhase)
        .map(([phase, count]) => `${phase} ${count}`)
        .join(", ")}), the highest ${percent(Math.max(fullest.normal.refTime, fullest.normal.proofSize))} at #${fullest.number}`,
    );
  }

  const creditBacklog = gameBlocks.filter((block) => block.creditTrees >= MAX_CREDIT_TREES);
  if (creditBacklog.length > 0) {
    capacity.push(`credit trees at the pallet's limit of ${MAX_CREDIT_TREES} waiting after ${creditBacklog.length} blocks, from #${creditBacklog[0].number}`);
  }

  const gameEndBlock = gameBlocks.find((block) => block.gameEvents.GameEnded);
  const deadline = (result.game.reportEnds + result.phases.player_process) * 1000;
  if (gameEndBlock && gameEndBlock.timestamp > deadline) {
    findings.push(`game end: GameEnded at #${gameEndBlock.number}, ${seconds(gameEndBlock.timestamp - deadline)} after report end plus player_process`);
  }
  return { findings, capacity };
}
