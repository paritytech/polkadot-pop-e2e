import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

export type Prove = (...args: [number, Uint8Array, Uint8Array, Uint8Array, Uint8Array]) => Promise<Uint8Array>;

// Each lane creates only one transaction/proof at a time; no unbounded promise queue.
export async function withProofWorkers<T>(count: number, build: (i: number, prove: Prove) => Promise<T>) {
  const workers: Worker[] = [];
  const result = new Array<T>(count);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(count, 8, Math.max(1, availableParallelism() - 1)) }, async () => {
      const worker = new Worker(new URL("./proof-worker.mjs", import.meta.url));
      workers.push(worker);
      let failed: Error | undefined;
      worker.on("error", (err) => { failed = err instanceof Error ? err : new Error(String(err)); });
      worker.on("exit", (code) => { failed ??= new Error(`proof worker exited (${code})`); });
      const prove: Prove = (...args) => new Promise((resolve, reject) => {
        if (failed) { reject(failed); return; }
        const cleanup = () => {
          worker.off("message", message);
          worker.off("error", error);
          worker.off("exit", exit);
        };
        const error = (err: Error) => { cleanup(); reject(err); };
        const exit = (code: number) => error(new Error(`proof worker exited (${code})`));
        const message = (reply: { proof: Uint8Array; error?: string }) => {
          cleanup();
          if (reply.error) reject(new Error(reply.error));
          else resolve(reply.proof);
        };
        worker.once("message", message).once("error", error).once("exit", exit);
        worker.postMessage(args);
      });
      for (let i = next++; i < count; i = next++) result[i] = await build(i, prove);
    }));
    return result;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
