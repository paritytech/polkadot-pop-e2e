import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, hash, prepared } from "./protocol.js";

const context = { run_id: "test", artifact_dir: "/tmp" };
async function exchange(script: string, requests: unknown[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.resume();
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await done;
  return Buffer.concat(output).toString().trim().split("\n").map((line) => JSON.parse(line));
}
const request = (id: number, operation: string, inputs = {}) => ({ protocol: 1, id, operation, inputs, context });

test("describe, invoke and shutdown preserve request IDs", async () => {
  const protocol = new URL("./protocol.ts", import.meta.url).href;
  const replies = await exchange(`import { serve } from ${JSON.stringify(protocol)};
    await serve({ id: 'test' }, async (_op, inputs) => ({ value: inputs.value * 2 }));`,
  [request(3, "$describe"), request(4, "double", { value: 21 }), request(5, "$shutdown")]);
  assert.deepEqual(replies, [
    { protocol: 1, id: 3, result: { id: "test" } },
    { protocol: 1, id: 4, result: { value: 42 } },
    { protocol: 1, id: 5, result: {} },
  ]);
});
test("actual manifest stays offline; unsupported protocols fail", async () => {
  const entry = new URL("./index.ts", import.meta.url).href;
  const [describe, shutdown] = await exchange(`await import(${JSON.stringify(entry)})`, [request(1, "$describe"), request(2, "$shutdown")]);
  assert.deepEqual(Object.keys(describe.result.operations).sort(), ["preflight", "prepare-claims", "recognize"]);
  assert.deepEqual(shutdown.result, {});
  const [bad] = await exchange(`await import(${JSON.stringify(entry)})`, [{ ...request(7, "$describe"), protocol: 2 }]);
  assert.equal(bad.id, 7);
  assert.equal(typeof bad.error, "string");
  assert.equal(bad.result, undefined);
});
test("PreparedTx hashes the complete bytes; artifacts hash their file bytes", async () => {
  // Known Substrate blake2_256 vector (digest size 32, not truncated BLAKE2-512).
  assert.equal(hash(Buffer.from("abc")), "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
  const bytes = Buffer.from("0c450001", "hex");
  const tx = prepared(bytes);
  assert.equal(tx.hash, hash(bytes));
  assert.notEqual(tx.hash, hash(bytes.subarray(1)));
  const dir = await mkdtemp(join(tmpdir(), "people-test-"));
  try {
    const ref = await artifact({ ...context, artifact_dir: dir }, "claims", [tx]);
    assert.equal(ref.version, 1);
    assert.equal(ref.blake2, hash(await readFile(ref.path)));
    assert.deepEqual(JSON.parse(await readFile(ref.path, "utf8")), [tx]);
  } finally { await rm(dir, { recursive: true }); }
});
