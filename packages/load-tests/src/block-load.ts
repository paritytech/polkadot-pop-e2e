import type { PolkadotClient } from "polkadot-api";
import { describeError } from "./burst.js";
import { bump } from "./stats.js";
import type { PeopleApi } from "./target.js";

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
  seenAt: number | null;
  extrinsics: number;
  /** Encoded length of the block's extrinsics. */
  bytes: number;
  /** Normal-class weight over the normal-class limit. */
  normal: WeightShare;
  /** Mandatory-class weight over the block's limit: inherents and hooks, and the game's steps where the runtime runs them in hooks. */
  mandatory: WeightShare;
  /** Ref time of the heaviest Game step call over the block's; null when the runtime runs no step as a call. */
  step: number | null;
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
  /** Proof size from `dev_getBlockStats`; null where the node doesn't serve it. */
  witnessBytes: number | null;
}

/** The pallet's limit on credit trees waiting to be built; a report that would exceed it fails with `CreditCapacityExhausted`. */
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

/** Finalized blocks read so far, in the order their reads complete. */
export interface BlockFollower {
  blocks: BlockLoad[];
  stop(): void;
}

/**
 * Reads every finalized People block once, as it is finalized, into `blocks`: six storage
 * reads and the body at the block's hash, and `dev_getBlockStats` while the node serves it.
 */
export async function followBlockLoad(client: PolkadotClient, api: PeopleApi): Promise<BlockFollower> {
  const blocks: BlockLoad[] = [];
  const { max_block: maxBlock, per_class: perClass } = await api.constants.System.BlockWeights();
  const maxNormal = perClass.normal.max_total!;
  const stepCallIndices = await readStepCallIndices(api);
  const share = (used: { ref_time: bigint; proof_size: bigint }, limit: { ref_time: bigint; proof_size: bigint }): WeightShare => ({
    refTime: Number(used.ref_time) / Number(limit.ref_time),
    proofSize: Number(used.proof_size) / Number(limit.proof_size),
  });
  let bestNumber = 0;
  // Null for the blocks of the first best chain, which the node imported before the run followed it.
  const seenAt = new Map<number, number | null>();
  let latestGameIndex: number | undefined;
  let blockStatsServed = true;
  const readWitnessBytes = async (hash: string): Promise<number | null> => {
    if (!blockStatsServed) return null;
    try {
      return (await client._request<{ witnessLen: number }>("dev_getBlockStats", [hash])).witnessLen;
    } catch {
      blockStatsServed = false;
      return null;
    }
  };

  const bestSubscription = client.bestBlocks$.subscribe({
    next: (best) => {
      const now = bestNumber === 0 ? null : Date.now();
      for (const { number } of best) if (!seenAt.has(number)) seenAt.set(number, now);
      bestNumber = Math.max(bestNumber, best[0]?.number ?? 0);
    },
    error: () => {},
  });
  const finalizedSubscription = client.finalizedBlock$.subscribe({
    next: async (block) => {
      const finalityLag = Math.max(0, bestNumber - block.number);
      const blockSeenAt = seenAt.get(block.number) ?? null;
      for (const number of seenAt.keys()) if (number < block.number) seenAt.delete(number);
      const at = { at: block.hash };
      try {
        const [weight, timestamp, events, game, creditCursor, unincluded, body, witnessBytes] = await Promise.all([
          api.query.System.BlockWeight.getValue(at),
          api.query.Timestamp.Now.getValue(at),
          api.query.System.Events.getValue(at),
          api.query.Game.Game.getValue(at),
          api.query.NftCredits.CreditBufferCursor.getValue(at),
          api.query.ParachainSystem.UnincludedSegment.getValue(at),
          client.getBlockBody(block.hash),
          readWitnessBytes(block.hash),
        ]);
        if (game) latestGameIndex = Math.max(latestGameIndex ?? 0, game.index);
        const failures: Record<string, number> = {};
        const gameEvents: Record<string, number> = {};
        let step: number | null = stepCallIndices.length > 0 ? 0 : null;
        for (const { phase, event } of events) {
          if (event.type === "Game") bump(gameEvents, event.value.type);
          if (event.type !== "System") continue;
          if (event.value.type === "ExtrinsicFailed") {
            bump(failures, describeError(event.value.value.dispatch_error));
          } else if (event.value.type === "ExtrinsicSuccess" && step !== null && phase.type === "ApplyExtrinsic" && latestGameIndex !== undefined) {
            const extrinsic = body[phase.value];
            if (extrinsic && isStepCall(extrinsic, stepCallIndices, latestGameIndex)) {
              step = Math.max(step, Number(event.value.value.dispatch_info.weight.ref_time) / Number(maxBlock.ref_time));
            }
          }
        }
        blocks.push({
          number: block.number,
          timestamp: Number(timestamp),
          seenAt: blockSeenAt,
          extrinsics: body.length,
          bytes: body.reduce((sum, extrinsic) => sum + extrinsic.length, 0),
          normal: share(weight.normal, maxNormal),
          mandatory: share(weight.mandatory, maxBlock),
          step,
          game: game ? { index: game.index, state: stateLabel(game) } : null,
          failures,
          gameEvents,
          creditTrees: Math.max(0, creditCursor - block.number + 1),
          unincluded: unincluded.length,
          finalityLag,
          witnessBytes,
        });
      } catch (error) {
        console.warn(`[chain] block #${block.number} not read: ${(error as Error).message}`);
      }
    },
    error: (error: Error) => console.warn(`[chain] finalized blocks no longer followed: ${error.message}`),
  });
  return {
    blocks,
    stop() {
      finalizedSubscription.unsubscribe();
      bestSubscription.unsubscribe();
    },
  };
}
