import { describe, expect, it } from "vitest";
import { measureBlock, type BlockReads, type ChainEvent, type ChainLimits } from "./block-load.js";

const ADVANCE_SHUFFLE = Uint8Array.of(0x37, 0x18);

const limits: ChainLimits = {
  maxBlock: { ref_time: 2_000n, proof_size: 10_000n },
  maxNormal: { ref_time: 1_500n, proof_size: 7_500n },
  stepBudget: 500n,
  stepCalls: [ADVANCE_SHUFFLE],
};

/** An extrinsic whose call is `call` with `game_index` and `discriminator`, behind `prefix` bytes of signature and extensions. */
function extrinsic(call: Uint8Array, gameIndex: number, prefix = 8): Uint8Array {
  const bytes = new Uint8Array(prefix + 10);
  bytes.set(call, prefix);
  const view = new DataView(bytes.buffer);
  view.setUint32(prefix + 2, gameIndex, true);
  view.setUint32(prefix + 6, 15_391, true);
  return bytes;
}

function success(index: number, refTime: bigint): ChainEvent {
  return {
    phase: { type: "ApplyExtrinsic", value: index },
    event: { type: "System", value: { type: "ExtrinsicSuccess", value: { dispatch_info: { weight: { ref_time: refTime, proof_size: 0n } } } } },
  };
}

function reads(changes: Partial<BlockReads> = {}): BlockReads {
  return {
    number: 100,
    arrivalTime: 600_000,
    finalityLag: 3,
    timestamp: 600_000,
    body: [],
    events: [],
    weight: { normal: { ref_time: 750n, proof_size: 750n }, mandatory: { ref_time: 100n, proof_size: 1_000n } },
    game: { index: 43, state: { type: "Shuffle", value: { step: { type: "Step1Insert" } } } },
    creditCursor: 0,
    unincludedLength: 2,
    witnessBytes: null,
    stepGameIndex: 43,
    ...changes,
  };
}

describe("measureBlock", () => {
  // Normal weight is compared with what the normal class may use, so "full" means no room for
  // more transactions; mandatory weight with the whole block, since it is not capped by class.
  it("measures normal weight against the normal limit and mandatory weight against the block", () => {
    expect(measureBlock(reads(), limits)).toMatchObject({ normal: { refTime: 0.5, proofSize: 0.1 }, mandatory: { refTime: 0.05, proofSize: 0.1 } });
  });

  // A block's buffer waits for the next block's tree, so a cursor at the block itself is one tree
  // waiting and one behind it is none; the pallet allows 8.
  it("counts credit trees waiting after the block from the buffer cursor", () => {
    expect([90, 99, 100, 107].map((creditCursor) => measureBlock(reads({ creditCursor }), limits).creditTrees)).toEqual([0, 0, 1, 8]);
  });

  // A step call's weight shows how close one step comes to the budget the pallet gives it; other
  // extrinsics, and the steps of another game, must not count.
  it("gives the heaviest step call of the game as a share of the step budget", () => {
    const body = [extrinsic(ADVANCE_SHUFFLE, 43), extrinsic(ADVANCE_SHUFFLE, 42), extrinsic(Uint8Array.of(0x37, 0x03), 43), extrinsic(ADVANCE_SHUFFLE, 43)];
    const events = [success(0, 200n), success(1, 450n), success(2, 480n), success(3, 300n)];
    expect(measureBlock(reads({ body, events }), limits).stepShare).toBe(0.6);
  });

  it("leaves the step share empty on a runtime without step calls", () => {
    expect(measureBlock(reads({ body: [extrinsic(ADVANCE_SHUFFLE, 43)], events: [success(0, 200n)] }), { ...limits, stepCalls: [] }).stepShare).toBeNull();
  });

  it("counts failed extrinsics by dispatch error and Game events by name", () => {
    const failed: ChainEvent = {
      phase: { type: "ApplyExtrinsic", value: 1 },
      event: { type: "System", value: { type: "ExtrinsicFailed", value: { dispatch_error: { type: "Module", value: { type: "Game", value: { type: "CreditCapacityExhausted" } } } } } },
    };
    const reported: ChainEvent = { phase: { type: "ApplyExtrinsic", value: 2 }, event: { type: "Game", value: { type: "ReportSubmitted", value: {} } } };
    expect(measureBlock(reads({ events: [failed, failed, reported] }), limits)).toMatchObject({
      failures: { "Module.Game.CreditCapacityExhausted": 2 },
      gameEvents: { ReportSubmitted: 1 },
      game: { index: 43, state: "Shuffle.Step1Insert" },
    });
  });
});
