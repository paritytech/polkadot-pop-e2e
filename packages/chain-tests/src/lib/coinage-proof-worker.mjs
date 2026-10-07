// Runs only inside a private worker. Never write entropy or job payloads to logs.
import { parentPort } from 'node:worker_threads';
import { one_shot } from 'verifiablejs/nodejs';
parentPort.on('message', ({ exponent, entropy, members, context, message }) => {
  const start = performance.now();
  try {
    const proof = one_shot(exponent, entropy, members, context, message).proof;
    parentPort.postMessage({ proof, computationMs: performance.now() - start });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});
