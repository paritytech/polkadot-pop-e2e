import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Transaction } from "polkadot-api";
import type { Player } from "./keys.js";
import type { Endpoints } from "./target.js";
import type { TurnProofOutcome } from "./video/turn.js";

/** How a transaction is signed: plainly, as a phone's host signs, or as the host signs as the score participant. */
export type SignerKind = "account" | "host" | "participant";

/** A transaction for the pool to sign: for `player`, on `chain`, at `nonce` or the chain's next one. */
export interface SigningEntry {
  player: Player;
  chain: "people" | "assetHub";
  signer: SignerKind;
  tx: Transaction;
  nonce?: number;
}

/** What a worker thread rebuilds a player from. */
export type PlayerKeys = Pick<Player, "index" | "secretKey" | "liteEntropy">;

type SignUpJob = { kind: "signUp"; player: PlayerKeys; drawTicket: boolean };
type BindJob = { kind: "bind"; player: PlayerKeys };
type SignJob = { kind: "sign"; player: PlayerKeys; chain: SigningEntry["chain"]; signer: SignerKind; callData: Uint8Array; nonce?: number };
type TurnProofJob = { kind: "turnProof"; liteEntropy: Uint8Array; productId: string; genesis: `0x${string}` };

/**
 * What a worker thread does: one player's sign-up, with a draw ticket or without; a lite bot's
 * bind of its game account; one transaction built from its call data; or a lite bot's TURN
 * proof. A player with `liteEntropy` signs up and binds as a lite person.
 */
export type SigningJob = SignUpJob | BindJob | SignJob | TurnProofJob;

/** A job's transaction signed and ready to send, or why it wasn't. */
export type SigningOutcome = { extrinsic: string } | { refusal: string };

/** A sign-up signed with how many draws it enters, and why none when it enters none; or why the app's sign-up left the player out. */
export type SignUpOutcome = { extrinsic: string; drawsEntered: number; drawSkip?: string } | { refusal: string };

/** How a lite bot's bind ended: a new or an existing binding, the route of a seat that takes no bind, or the chain's or the SDK's refusal. */
export type BindOutcome = { binding: "new" | "existing" } | { route: string } | { refusal: string };

export type OutcomeOf<J extends SigningJob> = J extends SignUpJob
  ? SignUpOutcome
  : J extends BindJob
    ? BindOutcome
    : J extends TurnProofJob
      ? TurnProofOutcome
      : SigningOutcome;

export type SigningReply = { id: number } & (OutcomeOf<SigningJob> | { error: string });

/** Jobs one worker thread has at once: a sign-up waits on several reads between its signatures. */
const JOBS_PER_WORKER = 8;

interface PoolWorker {
  worker: Worker;
  running: number;
}

/**
 * Worker threads that sign the run's transactions, one per core by default: polkadot-api's signers
 * decode the whole runtime metadata for every transaction, which on one thread takes longer than
 * registration lasts for a few thousand players.
 */
export class SigningPool {
  private readonly queue: Array<{ id: number; job: SigningJob }> = [];
  private readonly pending = new Map<number, { resolve(outcome: OutcomeOf<SigningJob>): void; reject(error: Error): void }>();
  private nextId = 0;

  private constructor(private readonly workers: PoolWorker[]) {
    for (const entry of workers) {
      entry.worker.on("message", ({ id, ...reply }: SigningReply) => {
        entry.running--;
        const waiting = this.pending.get(id);
        this.pending.delete(id);
        if ("error" in reply) waiting?.reject(new Error(reply.error));
        else waiting?.resolve(reply);
        this.dispatch();
      });
      entry.worker.on("error", (error) => {
        for (const waiting of this.pending.values()) waiting.reject(error as Error);
        this.pending.clear();
      });
    }
  }

  /** `size` worker threads connecting to `endpoints` as they first need each chain. */
  static open(endpoints: Endpoints, size = availableParallelism()): SigningPool {
    const workerData: Endpoints = { label: endpoints.label, rpc: endpoints.rpc, network: endpoints.network, assetHubRpc: endpoints.assetHubRpc };
    return new SigningPool(Array.from({ length: size }, () => ({ worker: new Worker(new URL("./signing-worker.ts", import.meta.url), { workerData }), running: 0 })));
  }

  get size(): number {
    return this.workers.length;
  }

  /** `player`'s sign-up as the app makes it, entering the game's draws with `drawTicket`. */
  signUp(player: Player, drawTicket: boolean): Promise<SignUpOutcome> {
    return this.run({ kind: "signUp", player: playerKeys(player), drawTicket });
  }

  /** A lite bot's game account bound to its lite person when its seat needs it, submitted by the worker as the app's bind submits it. */
  bind(player: Player): Promise<BindOutcome> {
    return this.run({ kind: "bind", player: playerKeys(player) });
  }

  /** A TURN proof of the current second with the lite key of `liteEntropy`, made when a thread takes the job. */
  proveTurn(liteEntropy: Uint8Array, productId: string, genesis: `0x${string}`): Promise<TurnProofOutcome> {
    return this.run({ kind: "turnProof", liteEntropy, productId, genesis });
  }

  /** Every entry signed, in order, logged under `label`. */
  async sign(entries: SigningEntry[], label: string): Promise<string[]> {
    const started = Date.now();
    const signed = await Promise.all(
      entries.map(async ({ player, chain, signer, tx, nonce }) => {
        const callData = await tx.getEncodedData();
        const outcome = await this.run({ kind: "sign", player: playerKeys(player), chain, signer, callData, nonce });
        if ("refusal" in outcome) throw new Error(`[${label}] ${player.address}: ${outcome.refusal}`);
        return outcome.extrinsic;
      }),
    );
    console.log(`[${label}] ${signed.length} transactions signed in ${((Date.now() - started) / 1000).toFixed(1)} s on ${this.size} threads`);
    return signed;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
  }

  private run<J extends SigningJob>(job: J): Promise<OutcomeOf<J>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The worker answers a job with that job's outcome.
      this.pending.set(id, { resolve: resolve as (outcome: OutcomeOf<SigningJob>) => void, reject });
      this.queue.push({ id, job });
      this.dispatch();
    });
  }

  private dispatch(): void {
    for (const entry of this.workers) {
      while (entry.running < JOBS_PER_WORKER && this.queue.length > 0) {
        entry.running++;
        entry.worker.postMessage(this.queue.shift());
      }
    }
  }
}

/** The parts of `player` a worker thread rebuilds it from: a `Player` carries functions, which don't cross threads. */
function playerKeys({ index, secretKey, liteEntropy }: Player): PlayerKeys {
  return { index, secretKey, liteEntropy };
}
