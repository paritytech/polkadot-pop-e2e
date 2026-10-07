import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { RingExponent } from 'verifiablejs/nodejs';

export type ProofInput = { exponent: RingExponent; entropy: Uint8Array; members: Uint8Array;
  context: Uint8Array; message: Uint8Array };
export type ProofOutput = { proof: Uint8Array; computationMs: number; elapsedMs: number };
type Job = { input: ProofInput; started: number; resolve: (value: ProofOutput) => void;
  reject: (error: Error) => void };
type Slot = { worker: Worker; job?: Job };

export const proofWorkerCount = () => {
  const count = Number(process.env.COINAGE_PROOF_WORKERS ?? Math.min(8, Math.max(1, Math.floor(availableParallelism() / 4))));
  assert(Number.isInteger(count) && count >= 1 && count <= 8, 'Proof worker count must be 1..8');
  return count;
};

/** Bounded CPU workers; callers bound preparation batches, and secrets never leave process memory. */
export class RingProofPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private failure?: Error;
  private closed = false;
  constructor(readonly size = proofWorkerCount()) {
    assert(Number.isInteger(size) && size >= 1 && size <= 8);
  }
  prove = (input: ProofInput): Promise<ProofOutput> => {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error('Proof pool closed'));
    if (!this.slots.length) this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ input, started: performance.now(), resolve, reject });
      this.drain();
    });
  };
  private start() {
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(new URL('./coinage-proof-worker.mjs', import.meta.url), { execArgv: [] });
      const slot: Slot = { worker };
      worker.on('message', (value: { proof?: Uint8Array; computationMs: number; error?: string }) => {
        const job = slot.job;
        if (!job) return;
        slot.job = undefined;
        worker.unref();
        if (value.error || !value.proof) job.reject(new Error(value.error ?? 'Missing worker proof'));
        else job.resolve({ proof: value.proof, computationMs: value.computationMs,
          elapsedMs: performance.now() - job.started });
        this.drain();
      });
      worker.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', code => { if (!this.closed) this.fail(new Error(`Proof worker exited: ${code}`)); });
      worker.unref();
      this.slots.push(slot);
    }
  }
  private fail(error: Error) {
    this.failure = error;
    for (const slot of this.slots) { slot.job?.reject(error); slot.job = undefined; }
    this.queue.splice(0).forEach(job => job.reject(error));
    void this.close();
  }
  private drain() {
    if (this.closed || this.failure) return;
    for (const slot of this.slots) {
      if (slot.job) continue;
      const job = this.queue.shift(); if (!job) break;
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage(job.input);
    }
  }
  async close() {
    this.closed = true;
    const error = new Error('Proof pool closed');
    this.queue.splice(0).forEach(job => job.reject(error));
    for (const slot of this.slots) { slot.job?.reject(error); slot.job = undefined; }
    await Promise.all(this.slots.map(slot => slot.worker.terminate()));
  }
}
