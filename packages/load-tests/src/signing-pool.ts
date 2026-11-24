import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Transaction } from "polkadot-api";
import type { Player } from "./keys.js";
import type { Endpoints } from "./target.js";

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

/** What a worker thread does: one player's sign-up, or one transaction given as its call data. */
export type SigningJob =
  | { kind: "signUp"; index: number; secretKey: Uint8Array }
  | { kind: "sign"; index: number; secretKey: Uint8Array; chain: SigningEntry["chain"]; signer: SignerKind; callData: Uint8Array; nonce?: number };

/** A job's transaction signed and ready to send, or why the app's sign-up left the player out. */
export type SigningOutcome = { extrinsic: string } | { refusal: string };

export type SigningReply = { id: number } & (SigningOutcome | { error: string });

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
  private readonly pending = new Map<number, { resolve(outcome: SigningOutcome): void; reject(error: Error): void }>();
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

  signUp(player: Player): Promise<SigningOutcome> {
    return this.run({ kind: "signUp", index: player.index, secretKey: player.secretKey });
  }

  /** Every entry signed, in order, logged under `label`. */
  async sign(entries: SigningEntry[], label: string): Promise<string[]> {
    const started = Date.now();
    const signed = await Promise.all(
      entries.map(async ({ player, chain, signer, tx, nonce }) => {
        const callData = await tx.getEncodedData();
        const outcome = await this.run({ kind: "sign", index: player.index, secretKey: player.secretKey, chain, signer, callData, nonce });
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

  private run(job: SigningJob): Promise<SigningOutcome> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
