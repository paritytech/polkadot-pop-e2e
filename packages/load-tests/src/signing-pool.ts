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

/** What a worker thread rebuilds a player from. */
export type PlayerKeys = Pick<Player, "index" | "secretKey" | "liteEntropy">;

/**
 * What a worker thread does: one player's sign-up, with a draw ticket or without; a lite bot's
 * bind of its game account; or one transaction given as its call data.
 */
export type SigningJob =
  | { kind: "signUp"; player: PlayerKeys; drawTicket: boolean }
  | { kind: "bind"; player: PlayerKeys }
  | { kind: "sign"; player: PlayerKeys; chain: SigningEntry["chain"]; signer: SignerKind; callData: Uint8Array; nonce?: number };

/** A job's transaction signed and ready to send, or why the app's sign-up left the player out. */
export type SigningOutcome = { extrinsic: string } | { refusal: string };

/** How a lite bot's bind ended: the SDK's outcome, a seat that takes no bind, or the chain's or the SDK's refusal. */
export type BindOutcome = { bound: "bound" | "already-bound" } | { skipped: string } | { refusal: string };

export type SigningReply = { id: number } & (SigningOutcome | BindOutcome | { error: string });

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
  private readonly pending = new Map<number, { resolve(outcome: SigningOutcome | BindOutcome): void; reject(error: Error): void }>();
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
  signUp(player: Player, drawTicket: boolean): Promise<SigningOutcome> {
    return this.run({ kind: "signUp", player: playerKeys(player), drawTicket }) as Promise<SigningOutcome>;
  }

  /** A lite bot's game account bound to its lite person, submitted by the worker as the app's bind submits it. */
  bind(player: Player): Promise<BindOutcome> {
    return this.run({ kind: "bind", player: playerKeys(player) }) as Promise<BindOutcome>;
  }

  /** Every entry signed, in order, logged under `label`. */
  async sign(entries: SigningEntry[], label: string): Promise<string[]> {
    const started = Date.now();
    const signed = await Promise.all(
      entries.map(async ({ player, chain, signer, tx, nonce }) => {
        const callData = await tx.getEncodedData();
        const outcome = (await this.run({ kind: "sign", player: playerKeys(player), chain, signer, callData, nonce })) as SigningOutcome;
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

  private run(job: SigningJob): Promise<SigningOutcome | BindOutcome> {
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

/** The parts of `player` a worker thread rebuilds it from: a `Player` carries functions, which don't cross threads. */
function playerKeys({ index, secretKey, liteEntropy }: Player): PlayerKeys {
  return { index, secretKey, liteEntropy };
}
