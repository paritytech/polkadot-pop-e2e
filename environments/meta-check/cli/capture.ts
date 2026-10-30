// capture live|candidate: get one runtime per chain into `<out>/<side>/<chain>.wasm`,
// and index them in `<out>/<side>.env` (`people=live/people.wasm`), for `report`.
//
// The side only names the folder; the runtime can come from any source:
//
//   --ports <ports.env>       :code from the fork's nodes (the engine's config/ports.env)
//   --rpc <chain=url,...>     :code from any node's HTTP RPC
//   --plan <chain=wasm file>  files already on disk, such as the gate's upgrades.env
//   --release <owner/repo@tag> --network <name>
//                             a release's asset, named by release-map.mjs (no token: public repos)
//
// Which chains: the plan's, or `--chains people,asset-hub`, or `--chains-from <chain=… file>`.
//
// Every chain is tried; one that fails is reported and left out of the index, and the
// command exits 1 at the end.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CHAINS } from "../../release-map.mjs";
import Runtime from "../runtime/index.ts";

export type Side = "live" | "candidate";

export type Source =
  | { kind: "ports"; ports: string }
  | { kind: "rpc"; urls: Map<string, string> }
  | { kind: "plan"; files: Map<string, string> }
  | { kind: "release"; repo: string; tag: string; network: string; base?: string };

const releaseAssets: Record<string, Record<string, { runtime?: Record<string, string> }>> = CHAINS;

/** `chain=path` lines, as `upgrades.env` holds them; relative paths are relative to the file. */
export function readChainFile(file: string): Map<string, string> {
  const pairs = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line): [string, string] => {
      const at = line.indexOf("=");
      if (at <= 0) throw new Error(`${file}: not a chain=path line: ${line}`);
      return [line.slice(0, at), path.resolve(path.dirname(file), line.slice(at + 1))];
    });
  return new Map(pairs);
}

/** chain -> its fork node's RPC URL, from the engine's `config/ports.env`. The relay is reached through alice. */
export function forkRpc(portsText: string): (chain: string) => string | undefined {
  const vars = new Map(
    portsText.split("\n").flatMap((line) => {
      const [, name, value] = /^\s*(\w+)=([^#\s]+)/.exec(line) ?? [];
      return name && value ? [[name, value] as const] : [];
    }),
  );
  return (chain) => {
    const port = vars.get(chain === "relay" ? "RELAY_ALICE_PORT" : `${chain.toUpperCase().replaceAll("-", "_")}_PORT`);
    return port ? `http://127.0.0.1:${port}` : undefined;
  };
}

/** A chain's `:code`, through `state_getStorage`. */
async function fetchCode(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_getStorage", params: ["0x3a636f6465"] }), // ":code"
    signal: AbortSignal.timeout(60_000),
  });
  const body: unknown = await response.json();
  const result = typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
  if (typeof result !== "string") throw new Error(`${url} returned no :code: ${JSON.stringify(body).slice(0, 200)}`);
  return Buffer.from(result.slice(2), "hex");
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The bytes of one chain's runtime, from the source. */
async function runtimeOf(chain: string, source: Source): Promise<Uint8Array> {
  switch (source.kind) {
    case "ports": {
      const url = forkRpc(fs.readFileSync(source.ports, "utf8"))(chain);
      if (!url) throw new Error(`${source.ports} has no port for ${chain}`);
      return fetchCode(url);
    }
    case "rpc": {
      const url = source.urls.get(chain);
      if (!url) throw new Error(`no --rpc URL for ${chain}`);
      return fetchCode(url);
    }
    case "plan": {
      const file = source.files.get(chain);
      if (!file) throw new Error(`the plan has no runtime for ${chain}`);
      return fs.readFileSync(file);
    }
    case "release": {
      const asset = releaseAssets[source.network]?.[chain]?.runtime?.[source.repo];
      if (!asset) throw new Error(`release-map.mjs has no ${source.repo} runtime for ${chain} on ${source.network}`);
      const base = source.base ?? "https://github.com";
      return download(`${base}/${source.repo}/releases/download/${source.tag}/${asset}`);
    }
  }
}

export interface Captured {
  chain: string;
  /** Relative to `out`. */
  file: string;
  specName: string;
  specVersion: number;
  codeHash: string;
}

/**
 * Write each chain's runtime to `<out>/<side>/<chain>.wasm` and index the ones that
 * worked in `<out>/<side>.env`. Each runtime is opened before it is kept, so a blob
 * that is not a runtime fails here rather than in `report`.
 */
export async function capture(
  side: Side,
  chains: string[],
  source: Source,
  out: string,
): Promise<{ captured: Captured[]; failed: { chain: string; error: string }[] }> {
  fs.mkdirSync(path.join(out, side), { recursive: true });
  const captured: Captured[] = [];
  const failed: { chain: string; error: string }[] = [];
  for (const chain of chains) {
    try {
      const code = await runtimeOf(chain, source);
      const { version } = new Runtime(code);
      const file = path.join(side, `${chain}.wasm`);
      fs.writeFileSync(path.join(out, file), code);
      captured.push({ chain, file, ...version });
    } catch (error) {
      failed.push({ chain, error: error instanceof Error ? error.message : String(error) });
    }
  }
  fs.writeFileSync(path.join(out, `${side}.env`), captured.map((c) => `${c.chain}=${c.file}\n`).join(""));
  return { captured, failed };
}

const pairs = (text: string): Map<string, string> =>
  new Map(
    text
      .split(",")
      .filter(Boolean)
      .map((pair): [string, string] => {
        const at = pair.indexOf("=");
        if (at <= 0) throw new Error(`not a chain=value pair: ${pair}`);
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );

const USAGE = `usage: main.ts capture <live|candidate> --out <dir> <source> [--chains a,b | --chains-from <file>]
  sources: --ports <ports.env> | --rpc <chain=url,...> | --plan <chain=wasm file> | --release <owner/repo@tag> --network <name>`;

/** `capture <side> ...`, from the command line. Returns the exit code. */
export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      ports: { type: "string" },
      rpc: { type: "string" },
      plan: { type: "string" },
      release: { type: "string" },
      network: { type: "string" },
      chains: { type: "string" },
      "chains-from": { type: "string" },
    },
  });
  const [side] = positionals;
  const fail = (message: string) => {
    console.error(`${message}\n${USAGE}`);
    return 2;
  };
  if (side !== "live" && side !== "candidate") return fail(`unknown side: ${side ?? "(none)"}`);
  if (!values.out) return fail("--out is required");

  let source: Source;
  if (values.ports) source = { kind: "ports", ports: values.ports };
  else if (values.rpc) source = { kind: "rpc", urls: pairs(values.rpc) };
  else if (values.plan) source = { kind: "plan", files: readChainFile(values.plan) };
  else if (values.release) {
    const [repo, tag] = values.release.split("@");
    if (!repo || !tag) return fail(`--release takes owner/repo@tag, not ${values.release}`);
    if (!values.network) return fail("--release needs --network, to name the asset per chain");
    source = { kind: "release", repo, tag, network: values.network };
  } else return fail("a source is required");

  const chains = values.chains
    ? values.chains.split(",").filter(Boolean)
    : values["chains-from"]
      ? [...readChainFile(values["chains-from"]).keys()]
      : source.kind === "plan"
        ? [...source.files.keys()]
        : [];
  if (chains.length === 0) {
    // Nothing to upgrade, as in a steady-state gate run: an empty index, not an error.
    console.error(`${side}: no chains to capture`);
  }

  const { captured, failed } = await capture(side, chains, source, values.out);
  for (const c of captured) {
    console.error(`${side} ${c.chain}: ${c.specName} ${c.specVersion}, ${c.codeHash.slice(0, 10)}… -> ${c.file}`);
  }
  for (const f of failed) console.error(`${side} ${f.chain}: could not capture: ${f.error}`);
  return failed.length > 0 ? 1 : 0;
}
