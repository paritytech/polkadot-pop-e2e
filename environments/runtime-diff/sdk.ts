// The product-sdk packages the chain tests run on: their versions, the selectors
// their shipped code reads, and the descriptors they carry.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHAINS } from "../release-map.mjs";
import { kindOf, type Descriptor, type RuntimeCtx } from "./entries.ts";
import { isRecord, readJson } from "./json.ts";

export const SDK_SCOPE = /^@parity\/(product-sdk|bulletin-sdk)/;

/** Walk up from `from` to the nearest node_modules/<name>, the way Node resolves it. */
export function findPackageDir(from: string, name: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

function readPackage(dir: string): { name: string; version: string; deps: string[] } {
  const pkg = readJson(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (!isRecord(pkg) || typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`${dir}/package.json has no name or version`);
  }
  const deps = [pkg.dependencies, pkg.peerDependencies].flatMap((d) => (isRecord(d) ? Object.keys(d) : []));
  return { name: pkg.name, version: pkg.version, deps };
}

export interface SdkPackage {
  name: string;
  version: string;
  dir: string;
  /** The package that depends on it. */
  from: string;
  /** The SDK packages it depends on. */
  deps: string[];
}

/**
 * Every product-sdk package reachable from `root`'s dependencies, at the version
 * actually installed. pnpm keeps each package's own dependencies next to it, so
 * resolving from the package's real path finds the version it pins.
 */
export function installedSdk(root: string): SdkPackage[] {
  const seen = new Map<string, SdkPackage>(); // real dir -> package
  const queue: { dir: string; entry: SdkPackage | null }[] = [{ dir: fs.realpathSync(root), entry: null }];
  for (let item = queue.shift(); item; item = queue.shift()) {
    const pkg = readPackage(item.dir);
    for (const name of pkg.deps.filter((d) => SDK_SCOPE.test(d))) {
      const found = findPackageDir(item.dir, name);
      if (!found) continue;
      item.entry?.deps.push(name);
      if (seen.has(found)) continue;
      const next = { name, version: readPackage(found).version, dir: found, from: pkg.name, deps: [] };
      seen.set(found, next);
      queue.push({ dir: found, entry: next });
    }
  }
  return [...seen.values()];
}

// `.query.Game.Players`, `?.query?.NetworkSuffix?.NetworkSuffix`, `.constants.Score.Suffix`.
const SELECTOR =
  /\??\.(?<kind>query|tx|constants|apis|event|view)\??\.(?<group>[A-Z][A-Za-z0-9_]*)\??\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/g;
const SOURCE_PREFIX: Record<string, string> = { constants: "constant", apis: "api" };

/** Selectors a piece of source reads through a typed or unsafe PAPI api. */
export function selectorsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const { groups } of source.matchAll(SELECTOR)) {
    if (!groups?.kind) continue;
    found.add(`${SOURCE_PREFIX[groups.kind] ?? groups.kind}:${groups.group ?? ""}.${groups.name ?? ""}`);
  }
  return found;
}

const filesUnder = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => /\.(m?js|cjs)$/.test(f) && !f.split(path.sep).includes("node_modules"))
        .map((f) => path.join(dir, f))
    : [];

/** Per SDK package: the selectors its shipped code reads. */
export function sdkSelectors(packages: SdkPackage[]): Record<string, string[]> {
  return Object.fromEntries(
    packages
      .filter((p) => !p.name.endsWith("-descriptors"))
      .map((p) => {
        const selectors = filesUnder(path.join(p.dir, "dist")).flatMap((f) => [...selectorsIn(fs.readFileSync(f, "utf8"))]);
        return [p.name, [...new Set(selectors)].sort()];
      }),
  );
}

const chains: Record<string, Record<string, { ws?: string }>> = CHAINS;

/**
 * The descriptor chain the SDK uses for a manifest chain: the one whose papi entry
 * points at the same public endpoint the release map records for it.
 */
export function descriptorChainFor(descriptorsDir: string, network: string, chain: string): string | null {
  const ws = chains[network]?.[chain]?.ws;
  const chainsDir = path.join(descriptorsDir, "chains");
  if (!ws || !fs.existsSync(chainsDir)) return null;
  const pointsAtWs = (name: string): boolean => {
    const config = path.join(chainsDir, name, ".papi", "polkadot-api.json");
    if (!fs.existsSync(config)) return false;
    const parsed = readJson(fs.readFileSync(config, "utf8"));
    const entries = isRecord(parsed) && isRecord(parsed.entries) ? Object.values(parsed.entries) : [];
    return entries.some((e) => isRecord(e) && e.wsUrl === ws);
  };
  return fs.readdirSync(chainsDir).find(pointsAtWs) ?? null;
}

const isDescriptor = (value: unknown): value is Descriptor =>
  isRecord(value) && "metadataTypes" in value && "descriptors" in value && "getMetadata" in value;

export async function loadDescriptor(descriptorsDir: string, name: string): Promise<Descriptor> {
  const file = path.join(descriptorsDir, "chains", name, "generated", "dist", "index.js");
  const mod: unknown = await import(pathToFileURL(file).href);
  const descriptor = isRecord(mod) ? Object.values(mod).find(isDescriptor) : undefined;
  if (!descriptor) throw new Error(`${name}: no descriptor export`);
  return descriptor;
}

export interface MissingSurface {
  selector: string;
  packages: string[];
  alsoMissingOnLive: boolean;
}

/**
 * SDK selectors the candidate does not carry, on a chain that has the pallet (or API)
 * at all: a People selector says nothing about Asset Hub. Ones live already lacked
 * are kept but marked: the SDK reads them optionally, or was already broken.
 */
export function missingSurfaces(bySdk: Record<string, string[]>, live: RuntimeCtx, candidate: RuntimeCtx) {
  const owners = new Map<string, string[]>();
  for (const [pkg, selectors] of Object.entries(bySdk)) {
    for (const s of selectors) owners.set(s, [...(owners.get(s) ?? []), pkg]);
  }
  const out: MissingSurface[] = [];
  for (const [selector, packages] of owners) {
    const [, prefix = "", group = "", name = ""] = /^(\w+):(\w+)\.(\w+)$/.exec(selector) ?? [];
    const kind = kindOf(prefix);
    if (!kind) continue;
    if (!live.hasGroup(kind, group) && !candidate.hasGroup(kind, group)) continue;
    if (candidate.entry(kind, group, name)) continue;
    out.push({ selector, packages, alsoMissingOnLive: !live.entry(kind, group, name) });
  }
  return out.sort(
    (a, b) => Number(a.alsoMissingOnLive) - Number(b.alsoMissingOnLive) || a.selector.localeCompare(b.selector),
  );
}
