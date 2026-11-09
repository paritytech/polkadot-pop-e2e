import { availableParallelism } from "node:os";
import { verifiableFor } from "../lib/verifiable-loader.js";
import { encodeMembers } from "../lib/ring.js";
import { withProofWorkers } from "./proofs.js";

const api = verifiableFor();
const entropy = Array.from({ length: 255 }, (_, i) => new Uint8Array(32).fill(i));
const members = encodeMembers(entropy.map((e) => api.member_from_entropy(e)));
const count = 200;
const start = performance.now();
await withProofWorkers(count, async (i, prove) => {
  const proof = await prove(9, entropy[i % 255], members, new Uint8Array(32), new Uint8Array(32).fill(i));
  if (proof.length !== 785) throw new Error(`bad proof size ${proof.length}`);
});
const seconds = (performance.now() - start) / 1000;
console.log(JSON.stringify({ count, ringMembers: 255, workers: Math.min(8, Math.max(1, availableParallelism() - 1)), seconds, proofsPerSecond: count / seconds }));
