// One chain's diff, and the capture of every chain the gate is about to upgrade.

import fs from "node:fs";
import path from "node:path";
import { descriptorCtx, diffEntries, runtimeCtx, type Descriptor, type EntryDiff } from "./entries.ts";
import { diffPipelines, type PipelineDiff } from "./extensions.ts";
import { isRecord, stringOr } from "./json.ts";
import {
  blake2Hex,
  decodeMetadata,
  metadataFromRuntime,
  runtimeVersion,
  type RuntimeVersion,
  type UnifiedMetadata,
} from "./metadata.ts";
import {
  descriptorChainFor,
  installedSdk,
  loadDescriptor,
  missingSurfaces,
  sdkSelectors,
  type MissingSurface,
  type SdkPackage,
} from "./sdk.ts";

export interface MetadataDiff {
  live: RuntimeVersion & { codeHash?: string };
  candidate: RuntimeVersion & { codeHash?: string };
  entries: EntryDiff[];
  extensions: PipelineDiff;
  missingSurfaces: MissingSurface[];
}

interface ChainHead {
  chain: string;
  /** The manifest's pin for the candidate runtime. */
  pin: string | null;
  wasm: string;
  descriptor: string | null;
}

export type ChainDiff = (ChainHead & MetadataDiff) | (ChainHead & { error: string });

export interface Diff {
  network: string;
  sdk: Omit<SdkPackage, "dir">[];
  /** Why the installed SDK could not be read; only extensions are compared then. */
  sdkError: string | null;
  /** `@parity/product-sdk-descriptors@<version>`, when installed. */
  descriptors: string | null;
  sdkSelectors: Record<string, string[]>;
  chains: ChainDiff[];
}

export const isDiff = (value: unknown): value is Diff =>
  isRecord(value) && typeof value.network === "string" && Array.isArray(value.chains) && Array.isArray(value.sdk);

export async function diffMetadata(
  liveMeta: UnifiedMetadata,
  candidateMeta: UnifiedMetadata,
  descriptor: Descriptor | null,
  bySdk: Record<string, string[]> = {},
): Promise<MetadataDiff> {
  const live = runtimeCtx(liveMeta);
  const candidate = runtimeCtx(candidateMeta);
  const sdkRefs = new Set(Object.values(bySdk).flat());
  return {
    live: runtimeVersion(liveMeta),
    candidate: runtimeVersion(candidateMeta),
    entries: descriptor ? diffEntries(await descriptorCtx(descriptor), live, candidate, sdkRefs) : [],
    extensions: diffPipelines(liveMeta, candidateMeta),
    missingSurfaces: missingSurfaces(bySdk, live, candidate),
  };
}

/** chain -> RPC port, from the engine's config/ports.env. The relay is reached through alice. */
export function forkPorts(text: string): (chain: string) => string | undefined {
  const vars = new Map(
    text
      .split("\n")
      .map((line) => /^\s*(\w+)=([^#\s]+)/.exec(line))
      .flatMap((m) => (m?.[1] && m[2] ? [[m[1], m[2]] as const] : [])),
  );
  return (chain) => vars.get(chain === "relay" ? "RELAY_ALICE_PORT" : `${chain.toUpperCase().replaceAll("-", "_")}_PORT`);
}

async function fetchCode(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_getStorage", params: ["0x3a636f6465"] }), // :code
    signal: AbortSignal.timeout(60_000),
  }).catch((error: unknown) => {
    throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const body: unknown = await res.json();
  const result = isRecord(body) ? body.result : undefined;
  if (typeof result !== "string") throw new Error(`${url}: no :code (${JSON.stringify(body).slice(0, 200)})`);
  return Buffer.from(result.slice(2), "hex");
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `<chain>=<wasm>` lines, as plan-upgrades.mjs writes them. */
export const readPlan = (text: string): [string, string][] =>
  text.split("\n").flatMap((line) => {
    const [chain = "", wasm = ""] = line.trim().split("=");
    return chain && wasm ? [[chain, wasm]] : [];
  });

export interface CaptureOptions {
  manifest: unknown;
  plan: [string, string][];
  /** chain -> URL or runtime file of the code the fork runs now. */
  liveSource: (chain: string) => string | undefined;
  out: string;
  testsDir: string;
}

/**
 * Diff every chain in the plan and write `<out>/diff.json`, plus each side's metadata
 * as `<chain>.live.scale` and `<chain>.candidate.scale`. A chain that cannot be
 * diffed records its error; the others still run. If the installed SDK cannot be
 * read, that error is recorded too and only the extensions are compared.
 */
export async function capture({ manifest, plan, liveSource, out, testsDir }: CaptureOptions): Promise<Diff> {
  if (!isRecord(manifest) || typeof manifest.network !== "string") throw new Error("the manifest has no network");
  const { network } = manifest;
  const pinOf = (chain: string): string | null => {
    const chains = isRecord(manifest.chains) ? manifest.chains[chain] : undefined;
    return isRecord(chains) ? stringOr(chains.runtime, null) : null;
  };
  fs.mkdirSync(out, { recursive: true });
  let sdk: SdkPackage[] = [];
  let bySdk: Record<string, string[]> = {};
  let sdkError: string | null = null;
  try {
    sdk = installedSdk(testsDir);
    bySdk = sdkSelectors(sdk);
  } catch (error) {
    sdk = [];
    sdkError = errorText(error);
  }
  const descriptors = sdk.find((p) => p.name === "@parity/product-sdk-descriptors");

  const chains: ChainDiff[] = [];
  for (const [chain, wasm] of plan) {
    const head = { chain, pin: pinOf(chain), wasm: path.basename(wasm) };
    let descriptor: string | null = null;
    try {
      descriptor = descriptors ? descriptorChainFor(descriptors.dir, network, chain) : null;
      const source = liveSource(chain);
      if (!source) throw new Error(`no RPC port known for ${chain}`);
      const liveCode = source.startsWith("http") ? await fetchCode(source) : fs.readFileSync(source);
      const candidateCode = fs.readFileSync(wasm);
      const liveBytes = metadataFromRuntime(liveCode);
      const candidateBytes = metadataFromRuntime(candidateCode);
      fs.writeFileSync(path.join(out, `${chain}.live.scale`), liveBytes);
      fs.writeFileSync(path.join(out, `${chain}.candidate.scale`), candidateBytes);
      const diff = await diffMetadata(
        decodeMetadata(liveBytes),
        decodeMetadata(candidateBytes),
        descriptors && descriptor ? await loadDescriptor(descriptors.dir, descriptor) : null,
        bySdk,
      );
      diff.live.codeHash = blake2Hex(liveCode);
      diff.candidate.codeHash = blake2Hex(candidateCode);
      chains.push({ ...head, descriptor, ...diff });
    } catch (error) {
      chains.push({ ...head, descriptor, error: errorText(error) });
    }
  }

  const result: Diff = {
    network,
    sdk: sdk.map(({ name, version, from, deps }) => ({ name, version, from, deps })),
    sdkError,
    descriptors: descriptors ? `${descriptors.name}@${descriptors.version}` : null,
    sdkSelectors: bySdk,
    chains,
  };
  fs.writeFileSync(path.join(out, "diff.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
