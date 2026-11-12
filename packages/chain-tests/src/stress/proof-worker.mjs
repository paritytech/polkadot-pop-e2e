import { parentPort } from "node:worker_threads";
import { one_shot } from "verifiablejs/nodejs";
parentPort.on("message", (args) => {
  try {
    parentPort.postMessage({ proof: one_shot(...args).proof });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});
