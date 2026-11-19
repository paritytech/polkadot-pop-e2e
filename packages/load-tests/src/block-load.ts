import type { PolkadotClient } from "polkadot-api";
import { readBlockContents, releaseBlockContents, type ChainEvent } from "./block-contents.js";
import { describeError } from "./burst.js";
import { bump } from "./stats.js";
import type { PeopleApi } from "./target.js";
import { sleep } from "./time.js";

/** Weight used over a limit, per dimension. */
export interface WeightShare {
  refTime: number;
  proofSize: number;
}

/** One finalized People block, read at its hash. */
export interface BlockLoad {
  number: number;
  /** `Timestamp.Now`, chain milliseconds: the relay chain's slot, which consecutive blocks can share. */
  timestamp: number;
  /** Wall-clock milliseconds when the run's RPC node first had this block number as best; null for blocks it had before the run followed it. */
  arrivalTime: number | null;
  extrinsics: number;
  /** Encoded length of the block's extrinsics. */
  bytes: number;
  /** Normal-class weight over the normal-class limit. */
  normal: WeightShare;
  /** Mandatory-class weight over the block's limit: inherents and hooks, and the game's steps where the runtime runs them in hooks. */
  mandatory: WeightShare;
  /** Ref time of the heaviest Game step call over the step budget, half the normal class's `max_extrinsic`; null when the runtime runs no step as a call. */
  stepShare: number | null;
  /** The game after this block; null without one. */
  game: { index: number; state: string } | null;
  /** Failed extrinsics by dispatch error. */
  failures: Record<string, number>;
  /** Game pallet events by name. */
  gameEvents: Record<string, number>;
  /** Credit trees still to build after this block: `NftCredits.CreditBufferCursor` minus the block number, plus one. */
  creditTrees: number;
  /** `ParachainSystem.UnincludedSegment` length: blocks built on this one's chain the relay chain hasn't included yet. */
  unincluded: number;
  /** Best block number minus this block's, when this block was finalized. */
  finalityLag: number;
  /** Proof size from `dev_getBlockStats`, read only for the run's game; null outside it, where the node doesn't serve it, or when the read failed. */
  witnessBytes: number | null;
}

/** The most NFT credit trees that can wait to be built; credits that don't fit fail with `CreditCapacityExhausted`. */
export const MAX_CREDIT_TREES = 8;

const STEP_CALLS = ["end_registration", "advance_shuffle", "end_reporting", "process_players", "advance_cancelling"] as const;
/** A step call's encoding: pallet and call index, then `game_index` and `discriminator`, both u32. */
const STEP_CALL_BYTES = 10;

export function stateLabel(game: { state: { type: string; value?: unknown } } | undefined): string {
  if (!game) return "None";
  const step = (game.state.value as { step?: { type: string } } | undefined)?.step;
  return step ? `${game.state.type}.${step.type}` : game.state.type;
}

/** Pallet and call index of each Game step call the runtime has; empty on a runtime that runs the steps in its hooks. */
async function readStepCallIndices(api: PeopleApi): Promise<Uint8Array[]> {
  const statics = await api.getStaticApis();
  return STEP_CALLS.filter((call) => statics.compat.tx.Game[call].isCompatible()).map((call) =>
    statics.tx.Game[call].getEncodedData({ game_index: 0, discriminator: 0 }).slice(0, 2),
  );
}

/** Whether `extrinsic` ends in a Game step call of game `gameIndex`: a call is the last part of an extrinsic. */
function isStepCall(extrinsic: Uint8Array, callIndices: Uint8Array[], gameIndex: number): boolean {
  if (extrinsic.length < STEP_CALL_BYTES) return false;
  const call = extrinsic.subarray(extrinsic.length - STEP_CALL_BYTES);
  return (
    callIndices.some((index) => index[0] === call[0] && index[1] === call[1]) &&
    new DataView(call.buffer, call.byteOffset + 2, 4).getUint32(0, true) === gameIndex
  );
}

type Weight = { ref_time: bigint; proof_size: bigint };

type ExtrinsicFailed = { dispatch_error: unknown };
type ExtrinsicSuccess = { dispatch_info: { weight: Weight } };

/** The chain's limits a block's weight is measured against. */
export interface ChainLimits {
  maxBlock: Weight;
  maxNormal: Weight;
  /** Ref time a Game step call may use: half the normal class's `max_extrinsic`. */
  stepBudget: bigint;
  /** Pallet and call index of each Game step call; empty on a runtime that runs the steps in its hooks. */
  stepCalls: Uint8Array[];
}

/** What the run reads of one block, at its hash. */
export interface BlockReads {
  number: number;
  arrivalTime: number | null;
  finalityLag: number;
  timestamp: number;
  body: Uint8Array[];
  events: ChainEvent[];
  weight: { normal: Weight; mandatory: Weight };
  game: { index: number; state: { type: string; value?: unknown } } | undefined;
  creditCursor: number;
  unincludedLength: number;
  witnessBytes: number | null;
  /** The game whose step calls count: the latest game seen up to this block. */
  stepGameIndex: number | undefined;
}

function share(used: Weight, limit: Weight): WeightShare {
  return { refTime: Number(used.ref_time) / Number(limit.ref_time), proofSize: Number(used.proof_size) / Number(limit.proof_size) };
}

export function measureBlock(reads: BlockReads, limits: ChainLimits): BlockLoad {
  const failures: Record<string, number> = {};
  const gameEvents: Record<string, number> = {};
  let stepShare: number | null = limits.stepCalls.length > 0 ? 0 : null;
  for (const { phase, event } of reads.events) {
    if (event.type === "Game") bump(gameEvents, event.value.type);
    if (event.type !== "System") continue;
    if (event.value.type === "ExtrinsicFailed") {
      const failed = event.value.value as ExtrinsicFailed;
      bump(failures, describeError(failed.dispatch_error));
    } else if (event.value.type === "ExtrinsicSuccess" && stepShare !== null && phase.type === "ApplyExtrinsic" && reads.stepGameIndex !== undefined) {
      const extrinsic = reads.body[phase.value as number];
      if (extrinsic && isStepCall(extrinsic, limits.stepCalls, reads.stepGameIndex)) {
        const success = event.value.value as ExtrinsicSuccess;
        stepShare = Math.max(stepShare, Number(success.dispatch_info.weight.ref_time) / Number(limits.stepBudget));
      }
    }
  }
  return {
    number: reads.number,
    timestamp: reads.timestamp,
    arrivalTime: reads.arrivalTime,
    extrinsics: reads.body.length,
    bytes: reads.body.reduce((sum, extrinsic) => sum + extrinsic.length, 0),
    normal: share(reads.weight.normal, limits.maxNormal),
    mandatory: share(reads.weight.mandatory, limits.maxBlock),
    stepShare,
    game: reads.game ? { index: reads.game.index, state: stateLabel(reads.game) } : null,
    failures,
    gameEvents,
    creditTrees: Math.max(0, reads.creditCursor - reads.number + 1),
    unincluded: reads.unincludedLength,
    finalityLag: reads.finalityLag,
    witnessBytes: reads.witnessBytes,
  };
}

/** Finalized blocks read so far, in the order their reads complete. */
export interface BlockFollower {
  blocks: BlockLoad[];
  /** Reads `dev_getBlockStats` for the blocks of game `index` and the block that ends it, from now on. */
  followGame(index: number): void;
  /** The highest best block number the node has had. */
  bestNumber(): number;
  /** Resolves true once a finalized block at or past `number` is read and no read of a block up to it is still running, false after `timeoutMs`. */
  waitForBlock(number: number, timeoutMs: number): Promise<boolean>;
  /** What the follower couldn't read, each kind with its count and first error. */
  notes(): string[];
  stop(): void;
}

/** JSON-RPC's "method not found", which a node returns for `dev_getBlockStats` when it doesn't serve unsafe methods. */
const METHOD_NOT_FOUND = -32601;

/**
 * Reads every finalized People block once, as it is finalized, into `blocks`: four storage reads
 * at the block's hash, its body, events and timestamp shared with any burst that reads the block,
 * and `dev_getBlockStats` for the blocks of the game `followGame` sets.
 */
export async function followBlockLoad(client: PolkadotClient, api: PeopleApi): Promise<BlockFollower> {
  const blocks: BlockLoad[] = [];
  const { max_block: maxBlock, per_class: perClass } = await api.constants.System.BlockWeights();
  const limits: ChainLimits = {
    maxBlock,
    maxNormal: perClass.normal.max_total!,
    stepBudget: perClass.normal.max_extrinsic!.ref_time / 2n,
    stepCalls: await readStepCallIndices(api),
  };
  const problems = new Map<string, { count: number; firstError: string }>();
  const recordProblem = (kind: string, error: string) => {
    const problem = problems.get(kind);
    if (problem) problem.count++;
    else problems.set(kind, { count: 1, firstError: error });
  };
  let bestNumber = 0;
  let highestRead = 0;
  // Reads finish out of order: a block of the run's game also waits for its PoV size.
  const pendingNumbers = new Set<number>();
  // Null for the blocks of the first best chain, which the node imported before the run followed it.
  const arrivalTimes = new Map<number, number | null>();
  let latestGameIndex: number | undefined;
  let statsGameIndex: number | undefined;
  let lastStatsGameBlock = -1;
  let blockStatsAvailable = true;
  const readWitnessBytes = async (hash: string): Promise<number | null> => {
    if (!blockStatsAvailable) return null;
    try {
      const stats = await client._request<{ witnessLen: number } | null>("dev_getBlockStats", [hash]);
      if (stats === null) recordProblem("PoV size not read", "the node has no stats for the block");
      return stats?.witnessLen ?? null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === METHOD_NOT_FOUND) blockStatsAvailable = false;
      else recordProblem("PoV size not read", (error as Error).message);
      return null;
    }
  };

  const bestSubscription = client.bestBlocks$.subscribe({
    next: (best) => {
      const now = bestNumber === 0 ? null : Date.now();
      for (const { number } of best) if (!arrivalTimes.has(number)) arrivalTimes.set(number, now);
      bestNumber = Math.max(bestNumber, best[0]?.number ?? 0);
    },
    error: (error: Error) => recordProblem("best blocks no longer followed, so later block times are missing", error.message),
  });
  const finalizedSubscription = client.finalizedBlock$.subscribe({
    next: async (block) => {
      const finalityLag = Math.max(0, bestNumber - block.number);
      const arrivalTime = arrivalTimes.get(block.number) ?? null;
      for (const number of arrivalTimes.keys()) if (number < block.number) arrivalTimes.delete(number);
      const at = { at: block.hash };
      pendingNumbers.add(block.number);
      try {
        const [weight, game, creditCursor, unincluded, contents] = await Promise.all([
          api.query.System.BlockWeight.getValue(at),
          api.query.Game.Game.getValue(at),
          api.query.NftCredits.CreditBufferCursor.getValue(at),
          api.query.ParachainSystem.UnincludedSegment.getValue(at),
          readBlockContents(client, api, block.hash),
        ]);
        if (game) latestGameIndex = Math.max(latestGameIndex ?? 0, game.index);
        const stepGameIndex = latestGameIndex;
        if (statsGameIndex !== undefined && game?.index === statsGameIndex) lastStatsGameBlock = Math.max(lastStatsGameBlock, block.number);
        const inStatsGame = statsGameIndex !== undefined && (game?.index === statsGameIndex || block.number === lastStatsGameBlock + 1);
        blocks.push(
          measureBlock(
            {
              number: block.number,
              arrivalTime,
              finalityLag,
              ...contents,
              weight,
              game,
              creditCursor,
              unincludedLength: unincluded.length,
              witnessBytes: inStatsGame ? await readWitnessBytes(block.hash) : null,
              stepGameIndex,
            },
            limits,
          ),
        );
        highestRead = Math.max(highestRead, block.number);
      } catch (error) {
        console.warn(`[chain] block #${block.number} not read: ${(error as Error).message}`);
        recordProblem("finalized block not read", `#${block.number}: ${(error as Error).message}`);
      } finally {
        releaseBlockContents(client, block.hash);
        pendingNumbers.delete(block.number);
      }
    },
    error: (error: Error) => recordProblem("finalized blocks no longer followed, so later blocks are missing", error.message),
  });
  return {
    blocks,
    followGame(index) {
      statsGameIndex = index;
    },
    bestNumber: () => bestNumber,
    async waitForBlock(number, timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (highestRead < number || [...pendingNumbers].some((pending) => pending <= number)) {
        if (Date.now() > until) return false;
        await sleep(500);
      }
      return true;
    },
    notes: () => [...problems].map(([kind, { count, firstError }]) => `${kind}: ${count} times, the first: ${firstError}`),
    stop() {
      finalizedSubscription.unsubscribe();
      bestSubscription.unsubscribe();
    },
  };
}
