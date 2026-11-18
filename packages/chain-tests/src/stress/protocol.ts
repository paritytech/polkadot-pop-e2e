import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { compact } from "@polkadot-api/substrate-bindings";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";

export const hash = (bytes: Uint8Array) => Buffer.from(blake2b256(bytes)).toString("hex");
export const prepared = (bytes: Uint8Array, metadata: unknown = null) => ({
  bytes: Buffer.from(bytes).toString("hex"), hash: hash(bytes), metadata,
});
// Runtime APIs encode OpaqueExtrinsic as Bytes, adding the compact length themselves.
export const extrinsicBody = (bytes: Uint8Array) => Uint8Array.from(bytes.subarray(compact.enc(compact.dec(bytes)).length));
export type Context = { run_id: string; artifact_dir: string };
export async function artifact(context: Context, name: string, value: unknown) {
  await mkdir(context.artifact_dir, { recursive: true });
  const path = resolve(context.artifact_dir, `${name}-${randomUUID()}.json`);
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(path, bytes, { mode: 0o600 });
  return { version: 1, path, blake2: hash(bytes) };
}

// Bound even an unterminated input line. PolkaMeter serializes requests.
export async function serve(manifest: unknown, invoke: (op: string, inputs: any, context: Context) => Promise<unknown>) {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end + 1 > 8 * 1024 * 1024) throw new Error("request exceeds 8 MiB");
      const request = JSON.parse(pending.subarray(0, end).toString());
      pending = pending.subarray(end + 1);
      const { id, operation, inputs, context } = request;
      let response;
      try {
        if (request.protocol !== 1) throw new Error("unsupported protocol");
        const result = operation === "$describe" ? manifest : operation === "$shutdown" ? {}
          : await invoke(operation, inputs, context);
        response = { protocol: 1, id, result };
      } catch (error) {
        // Operation failures can contain credentials in third-party errors.
        const detail = String(error);
        console.error(inputs?.credential ? detail.replaceAll(inputs.credential, "[redacted]") : detail);
        response = { protocol: 1, id, error: "People operation failed; check inputs and chain compatibility" };
      }
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (operation === "$shutdown" || "error" in response) return;
    }
    if (pending.length >= 8 * 1024 * 1024) throw new Error("request exceeds 8 MiB");
  }
  if (pending.length) throw new Error("truncated protocol message");
}
