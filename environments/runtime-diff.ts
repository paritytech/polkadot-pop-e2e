// Runtime diff: what a candidate runtime changes for the product-sdk the gate tests through.
//
//   tsx environments/runtime-diff.ts capture <candidate-manifest.json> <upgrades.env> \
//     --ports ppn/config/ports.env --out runtime-diff [--tests-dir packages/chain-tests]
//
// Runs between "Decide which runtimes to upgrade" and the upgrade itself, while the
// fork still runs what it took from live. For every chain about to be upgraded it
// reads the fork's `:code`, takes the metadata of both blobs from the wasm executor,
// and compares them on the surface the pinned @parity/product-sdk-descriptors carry:
//
//   - entries (calls, storage, constants, events, runtime APIs, view functions), each
//     graded the way polkadot-api grades it at runtime: the descriptor against the
//     live runtime, then against the candidate. See `grade` for the three grades.
//   - transaction extension pipelines per extension version, so a set of extensions
//     moving from v0 to a new v1 shows as that, not as "metadata changed".
//   - SDK selectors (`query:NetworkSuffix.NetworkSuffix`) the SDK's own code reads and
//     the candidate no longer has.
//
// The output is `<out>/diff.json`; runtime-report.ts joins it with the test results.
// Reading the runtime and its pipelines is Runtime Watch's code, copied into
// runtime-watch/ (see the header there for what changed and what was left out).
//
// This is diagnosis only. Every failure here is reported in the JSON and never fails
// the gate: the chain tests are the verdict.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Tuple, Vector } from "@polkadot-api/substrate-bindings";
import { getLookupFn } from "@polkadot-api/metadata-builders";
import {
  CompatibilityLevel,
  EntryPointCodec,
  TypedefCodec,
  entryPointsAreCompatible,
  enumValueEntryPointNode,
  mapLookupToTypedef,
  runtimeCallEntryPoint,
  singleValueEntryPoint,
  storageEntryPoint,
  voidEntryPointNode,
  type EntryPoint,
  type TypedefNode,
} from "@polkadot-api/metadata-compatibility";
import { CHAINS } from "./release-map.mjs";
import {
  blake2Hex,
  decodeMetadata,
  extensionPipelines,
  metadataFromRuntime,
  runtimeVersion,
  type RuntimeVersion,
  type UnifiedMetadata,
} from "./runtime-watch/metadata.ts";
import { pipelineChange, type PipelineChange } from "./runtime-watch/diagnosis.ts";

const CODE_KEY = "0x3a636f6465"; // ":code"

type LevelName = keyof typeof CompatibilityLevel;
const levelName = (level: CompatibilityLevel): LevelName => CompatibilityLevel[level] as LevelName;

// Descriptor kinds as polkadot-api names them, and the selector prefix Runtime Watch
// uses for each: `query:People.People`, `constant:Score.Suffix`.
const KINDS = {
  storage: "query",
  tx: "tx",
  events: "event",
  constants: "constant",
  viewFns: "view",
  apis: "api",
} as const;
export type Kind = keyof typeof KINDS;
type Prefix = (typeof KINDS)[Kind];
const PREFIX_TO_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, p]) => [p, k])) as Record<Prefix, Kind>;
const KIND_NAMES = Object.keys(KINDS) as Kind[];

// ---------------------------------------------------------------------------
// The two sides of a comparison
// ---------------------------------------------------------------------------

/** What the compatibility check needs from a runtime or a descriptor. */
export interface Ctx {
  getTypeDefNode: (id: number) => TypedefNode;
  entry: (kind: Kind, group: string, name: string) => EntryPoint | undefined;
}

export interface RuntimeCtx extends Ctx {
  groups: (kind: Kind) => string[];
}

export interface DescriptorCtx extends Ctx {
  names: (kind: Kind) => Array<[string, string]>;
}

/**
 * The same view of a runtime polkadot-api builds for its compatibility checks
 * (polkadot-api/src/compatibility/compat-ctx.js): an entry point per surface, and a
 * typedef node per type id.
 */
export function runtimeCtx(metadata: UnifiedMetadata): RuntimeCtx {
  const lookup = getLookupFn(metadata);
  const nodes = new Map<number, TypedefNode>();
  const getTypeDefNode = (id: number): TypedefNode => {
    let node = nodes.get(id);
    if (!node) nodes.set(id, (node = mapLookupToTypedef(lookup(id))));
    return node;
  };
  const enumVariants = (ref: { type: number } | undefined) => {
    if (!ref) return {};
    const entry = lookup(ref.type);
    return entry.type === "enum" ? entry.value : {};
  };
  const entries = Object.fromEntries(KIND_NAMES.map((kind) => [kind, {}])) as Record<
    Kind,
    Record<string, Record<string, EntryPoint>>
  >;
  for (const pallet of metadata.pallets) {
    const name = pallet.name;
    entries.storage[name] = Object.fromEntries(
      (pallet.storage?.items ?? []).map((item) => [item.name, storageEntryPoint(item)]),
    );
    entries.tx[name] = Object.fromEntries(
      Object.entries(enumVariants(pallet.calls)).map(([call, v]) => [
        call,
        { args: enumValueEntryPointNode(v), values: voidEntryPointNode },
      ]),
    );
    entries.events[name] = Object.fromEntries(
      Object.entries(enumVariants(pallet.events)).map(([event, v]) => [
        event,
        { args: voidEntryPointNode, values: enumValueEntryPointNode(v) },
      ]),
    );
    entries.constants[name] = Object.fromEntries(pallet.constants.map((c) => [c.name, singleValueEntryPoint(c.type)]));
    entries.viewFns[name] = Object.fromEntries(
      ("viewFns" in pallet ? pallet.viewFns : []).map((fn) => [fn.name, runtimeCallEntryPoint(fn)]),
    );
  }
  for (const api of metadata.apis) {
    entries.apis[api.name] = Object.fromEntries(api.methods.map((m) => [m.name, runtimeCallEntryPoint(m)]));
  }
  return {
    getTypeDefNode,
    entry: (kind, group, name) => entries[kind][group]?.[name],
    groups: (kind) => Object.keys(entries[kind]),
  };
}

/** The part of a PAPI descriptors export the comparison reads. */
export interface Descriptor {
  metadataTypes: Promise<Uint8Array> | Uint8Array;
  descriptors: Promise<Partial<Record<Kind, Record<string, Record<string, number>>>>>;
  getMetadata?: () => Promise<Uint8Array>;
}

/** The descriptor side of the same comparison. */
export async function descriptorCtx(descriptor: Descriptor): Promise<DescriptorCtx> {
  const [types, values] = await Promise.all([descriptor.metadataTypes, descriptor.descriptors]);
  const [entryPoints, typedefs] = Tuple(Vector(EntryPointCodec), Vector(TypedefCodec)).dec(types);
  return {
    getTypeDefNode: (id) => typedefs[id]!,
    entry: (kind, group, name) => {
      const idx = values[kind]?.[group]?.[name];
      return idx == null ? undefined : entryPoints[idx];
    },
    names: (kind) =>
      Object.entries(values[kind] ?? {}).flatMap(([group, members]) =>
        Object.keys(members ?? {}).map((name): [string, string] => [group, name]),
      ),
  };
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * How well the SDK's descriptor fits a runtime, as polkadot-api's `isCompatible`
 * decides it: a call needs its arguments to encode, a constant or event its value to
 * decode, storage and runtime APIs both.
 */
export function sdkLevel(
  kind: Kind,
  user: { ctx: Ctx; entry: EntryPoint },
  dest: { ctx: Ctx; group: string; name: string },
): CompatibilityLevel {
  const destEntry = dest.ctx.entry(kind, dest.group, dest.name);
  if (!destEntry) return CompatibilityLevel.Incompatible;
  const result = entryPointsAreCompatible(
    user.entry,
    user.ctx.getTypeDefNode,
    destEntry,
    dest.ctx.getTypeDefNode,
    new Map(),
  );
  if (kind === "tx") return result.args.level;
  if (kind === "constants" || kind === "events") return result.values.level;
  return Math.min(result.args.level, result.values.level);
}

export interface ChangePath {
  side: "args" | "value";
  path: string;
  level: LevelName;
}

/** What changed between two runtimes for one entry, with the paths PAPI reports. */
function entryChange(kind: Kind, live: Ctx, candidate: Ctx, group: string, name: string) {
  const a = live.entry(kind, group, name);
  const b = candidate.entry(kind, group, name);
  if (!a && !b) return null;
  if (!b) return { change: "removed" as const, paths: [] };
  if (!a) return { change: "added" as const, paths: [] };
  const result = entryPointsAreCompatible(a, live.getTypeDefNode, b, candidate.getTypeDefNode, new Map(), true);
  if (result.args.level === CompatibilityLevel.Identical && result.values.level === CompatibilityLevel.Identical) {
    return null;
  }
  const paths: ChangePath[] = [
    ...result.args.changes.map((c) => ({ side: "args" as const, path: c.path, level: levelName(c.level) })),
    ...result.values.changes.map((c) => ({ side: "value" as const, path: c.path, level: levelName(c.level) })),
  ];
  return { change: "changed" as const, paths: dedupePaths(paths) };
}

// PAPI reports a change at every level of the tree it passes through; the deepest
// one is the useful one.
function dedupePaths(paths: ChangePath[]): ChangePath[] {
  const keep = paths.filter((p) => !paths.some((q) => q !== p && q.side === p.side && q.path.startsWith(`${p.path}.`)));
  return keep.slice(0, 8);
}

export type Severity = "breaking" | "partial" | "additive";

/**
 * What a change does to the SDK, from how well the descriptor fits live and the
 * candidate:
 *
 * - breaking: the fit got worse and is now Incompatible. polkadot-api refuses the
 *   entry for every value, so every SDK call through it fails.
 * - partial: the fit got worse and is now Partial. polkadot-api checks each value
 *   when it is used, so a call fails only for some values. An event that gains a
 *   variant, or a call whose enum argument loses one, lands here.
 * - additive: anything else. The SDK fits as well as it did: a new entry, a new
 *   optional field, a change only in what the SDK never sends.
 *
 * An entry the SDK already could not use on live stays additive; this run did not
 * cause it.
 */
export function grade(before: CompatibilityLevel, after: CompatibilityLevel): Severity {
  if (after >= before) return "additive";
  if (after === CompatibilityLevel.Incompatible) return "breaking";
  if (after === CompatibilityLevel.Partial) return "partial";
  return "additive";
}

export interface EntryDiff {
  selector: string;
  kind: Kind;
  change: "added" | "removed" | "changed";
  severity: Severity;
  sdk: { live: LevelName; candidate: LevelName };
  paths: ChangePath[];
  sdkRef?: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { breaking: 0, partial: 1, additive: 2 };

/** Every descriptor entry the two runtimes disagree on, graded for the SDK. */
export function diffEntries(descriptor: DescriptorCtx, live: Ctx, candidate: Ctx): EntryDiff[] {
  const out: EntryDiff[] = [];
  for (const kind of KIND_NAMES) {
    for (const [group, name] of descriptor.names(kind)) {
      const delta = entryChange(kind, live, candidate, group, name);
      if (!delta) continue;
      const user = { ctx: descriptor, entry: descriptor.entry(kind, group, name)! };
      const before = sdkLevel(kind, user, { ctx: live, group, name });
      const after = sdkLevel(kind, user, { ctx: candidate, group, name });
      out.push({
        selector: `${KINDS[kind]}:${group}.${name}`,
        kind,
        change: delta.change,
        severity: grade(before, after),
        sdk: { live: levelName(before), candidate: levelName(after) },
        paths: delta.paths,
      });
    }
  }
  return out.sort(bySeverityThenSelector);
}

const bySeverityThenSelector = (a: EntryDiff, b: EntryDiff): number =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.selector.localeCompare(b.selector);

// ---------------------------------------------------------------------------
// Transaction extensions
// ---------------------------------------------------------------------------

type Extension = UnifiedMetadata["extrinsic"]["extensionsByVersion"][number][number];

export interface PipelineRow {
  version: number;
  before: string[];
  after: string[];
  status: "same" | "changed" | "added" | "removed";
  severity: "none" | "breaking" | "additive";
  added: string[];
  removed: string[];
  reordered: boolean;
  retyped: string[];
}

export interface PipelineDiff {
  versions: PipelineRow[];
  moved: Array<{ identifier: string; from: number[]; to: number[] }>;
  summary: string;
  /** Runtime Watch's reading of the same change, when it is the person-pipeline split. */
  watch: PipelineChange | null;
  extrinsicVersions: { live: number[]; candidate: number[]; removed: number[]; added: number[] };
}

const ids = (list: Extension[] | undefined): string[] => (list ?? []).map((e) => e.identifier);

/**
 * Per extension version: what was added, removed or reordered, and which extensions
 * kept their name but changed type. A changed or removed pipeline is breaking: a
 * signer built for it produces transactions the candidate rejects. A new version is
 * additive. `moved` names extensions that left one version for another, which is how
 * "the person extensions moved from v0 to a new v1" reads.
 */
export function diffPipelines(liveMeta: UnifiedMetadata, candidateMeta: UnifiedMetadata): PipelineDiff {
  const live = liveMeta.extrinsic.extensionsByVersion;
  const candidate = candidateMeta.extrinsic.extensionsByVersion;
  const liveCtx = runtimeCtx(liveMeta);
  const candidateCtx = runtimeCtx(candidateMeta);
  const versions = [...new Set([...Object.keys(live), ...Object.keys(candidate)].map(Number))].sort((a, b) => a - b);

  const typeChanged = (a: Extension, b: Extension): boolean => {
    const node = (e: Extension): EntryPoint => ({
      args: { type: "lookup", value: e.type },
      values: { type: "lookup", value: e.additionalSigned },
    });
    const r = entryPointsAreCompatible(node(a), liveCtx.getTypeDefNode, node(b), candidateCtx.getTypeDefNode, new Map());
    return r.args.level !== CompatibilityLevel.Identical || r.values.level !== CompatibilityLevel.Identical;
  };

  const rows = versions.map((version): PipelineRow => {
    const before = live[version];
    const after = candidate[version];
    const row = { version, before: ids(before), after: ids(after), added: [], removed: [], reordered: false, retyped: [] };
    if (!before) return { ...row, status: "added", severity: "additive" };
    if (!after) return { ...row, status: "removed", severity: "breaking" };
    const added = row.after.filter((id) => !row.before.includes(id));
    const removed = row.before.filter((id) => !row.after.includes(id));
    const common = row.before.filter((id) => row.after.includes(id));
    const reordered = common.join() !== row.after.filter((id) => row.before.includes(id)).join();
    const retyped = common.filter((id) =>
      typeChanged(before.find((e) => e.identifier === id)!, after.find((e) => e.identifier === id)!),
    );
    const same = !added.length && !removed.length && !reordered && !retyped.length;
    return {
      ...row,
      status: same ? "same" : "changed",
      severity: same ? "none" : "breaking",
      added,
      removed,
      reordered,
      retyped,
    };
  });

  const versionsOf = (pipelines: Record<number, Extension[]>, id: string): number[] =>
    Object.entries(pipelines)
      .filter(([, list]) => ids(list).includes(id))
      .map(([v]) => Number(v));
  const everyId = [...new Set(Object.values(live).flatMap(ids))];
  const moved = everyId
    .map((id) => ({ identifier: id, from: versionsOf(live, id), to: versionsOf(candidate, id) }))
    .filter((m) => m.from.some((v) => !m.to.includes(v)) && m.to.some((v) => !m.from.includes(v)));

  const liveX = [...liveMeta.extrinsic.version];
  const candidateX = [...candidateMeta.extrinsic.version];
  return {
    versions: rows,
    moved,
    summary: pipelineSummary(rows, moved),
    watch: pipelineChange(extensionPipelines(liveMeta), extensionPipelines(candidateMeta)),
    extrinsicVersions: {
      live: liveX,
      candidate: candidateX,
      removed: liveX.filter((v) => !candidateX.includes(v)),
      added: candidateX.filter((v) => !liveX.includes(v)),
    },
  };
}

function pipelineSummary(rows: PipelineRow[], moved: PipelineDiff["moved"]): string {
  const parts: string[] = [];
  for (const r of rows) {
    if (r.status === "added") parts.push(`new pipeline v${r.version}`);
    if (r.status === "removed") parts.push(`pipeline v${r.version} removed`);
  }
  if (moved.length) {
    const groups = new Map<string, string[]>();
    for (const m of moved) {
      const key = `v${m.from.join("+v")} to v${m.to.join("+v") || "(none)"}`;
      groups.set(key, [...(groups.get(key) ?? []), m.identifier]);
    }
    for (const [route, list] of groups) parts.push(`${list.join(", ")} moved from ${route}`);
  }
  // A moved extension is already said; listing it again as gained and lost buries the
  // rest of the change.
  const wasMoved = new Set(moved.map((m) => m.identifier));
  for (const r of rows) {
    if (r.status === "changed") {
      const bits: string[] = [];
      const added = r.added.filter((id) => !wasMoved.has(id));
      const removed = r.removed.filter((id) => !wasMoved.has(id));
      if (added.length) bits.push(`gained ${added.join(", ")}`);
      if (removed.length) bits.push(`lost ${removed.join(", ")}`);
      if (r.reordered) bits.push("reordered");
      if (r.retyped.length) bits.push(`${r.retyped.join(", ")} changed type`);
      if (bits.length) parts.push(`v${r.version} ${bits.join("; ")}`);
    }
  }
  return parts.length ? `${parts.join(". ")}.` : "No change.";
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

/** Walk up from `from` to the nearest node_modules/<name>, the way Node resolves it. */
export function findPackageDir(from: string, name: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

export const SDK_SCOPE = /^@parity\/(product-sdk|bulletin-sdk)/;

export interface SdkPackage {
  name: string;
  version: string;
  dir: string;
  from: string;
  deps: string[];
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const readPackage = (dir: string): PackageJson =>
  JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;

/**
 * Every @parity product-sdk package reachable from `root`'s dependencies, at the
 * version actually installed. pnpm keeps each package's own dependencies next to it,
 * so resolving from the package's real path finds the version it pins.
 */
export function installedSdk(root: string): SdkPackage[] {
  const seen = new Map<string, SdkPackage>(); // real dir -> package
  const queue: Array<{ dir: string; entry: SdkPackage | null }> = [{ dir: fs.realpathSync(root), entry: null }];
  while (queue.length) {
    const { dir, entry } = queue.shift()!;
    const pkg = readPackage(dir);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      if (!SDK_SCOPE.test(name)) continue;
      const found = findPackageDir(dir, name);
      if (!found) continue;
      entry?.deps.push(name);
      if (seen.has(found)) continue;
      const next: SdkPackage = { name, version: readPackage(found).version, dir: found, from: pkg.name, deps: [] };
      seen.set(found, next);
      queue.push({ dir: found, entry: next });
    }
  }
  return [...seen.values()];
}

// `.query.Game.Players`, `?.query?.NetworkSuffix?.NetworkSuffix`, `.constants.Score.Suffix`.
const SELECTOR = /\??\.(query|tx|constants|apis|event|view)\??\.([A-Z][A-Za-z0-9_]*)\??\.([A-Za-z_][A-Za-z0-9_]*)/g;
const SOURCE_PREFIX: Record<string, Prefix> = {
  query: "query",
  tx: "tx",
  constants: "constant",
  apis: "api",
  event: "event",
  view: "view",
};

/** Selectors a piece of source reads through a typed or unsafe PAPI api. */
export function selectorsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(SELECTOR)) found.add(`${SOURCE_PREFIX[m[1]!]}:${m[2]}.${m[3]}`);
  return found;
}

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : filesUnder(p, keep);
    return keep(p) ? [p] : [];
  });
}

/** Per SDK package: the selectors its shipped code reads. */
export function sdkSelectors(packages: SdkPackage[]): Record<string, string[]> {
  return Object.fromEntries(
    packages
      .filter((p) => !p.name.endsWith("-descriptors"))
      .map((p) => {
        const selectors = new Set<string>();
        for (const file of filesUnder(path.join(p.dir, "dist"), (f) => /\.(m?js|cjs)$/.test(f))) {
          for (const s of selectorsIn(fs.readFileSync(file, "utf8"))) selectors.add(s);
        }
        return [p.name, [...selectors].sort()];
      }),
  );
}

/**
 * The descriptor chain the SDK uses for a manifest chain: the one whose papi entry
 * points at the same public endpoint the release map records for it.
 */
export function descriptorChainFor(descriptorsDir: string, network: string, chain: string): string | null {
  const chains = CHAINS as Record<string, Record<string, { ws?: string } | undefined> | undefined>;
  const ws = chains[network]?.[chain]?.ws;
  if (!ws) return null;
  const chainsDir = path.join(descriptorsDir, "chains");
  for (const name of fs.existsSync(chainsDir) ? fs.readdirSync(chainsDir) : []) {
    const config = path.join(chainsDir, name, ".papi", "polkadot-api.json");
    if (!fs.existsSync(config)) continue;
    const { entries = {} } = JSON.parse(fs.readFileSync(config, "utf8")) as {
      entries?: Record<string, { wsUrl?: string }>;
    };
    if (Object.values(entries).some((e) => e.wsUrl === ws)) return name;
  }
  return null;
}

export async function loadDescriptor(descriptorsDir: string, name: string): Promise<Descriptor> {
  const file = path.join(descriptorsDir, "chains", name, "generated", "dist", "index.js");
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const descriptor = Object.values(mod).find(
    (v): v is Descriptor => !!v && typeof v === "object" && "metadataTypes" in v && "descriptors" in v,
  );
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
export function missingSurfaces(
  bySdk: Record<string, string[]>,
  live: RuntimeCtx,
  candidate: RuntimeCtx,
): MissingSurface[] {
  const owners = new Map<string, string[]>();
  for (const [pkg, selectors] of Object.entries(bySdk)) {
    for (const s of selectors) owners.set(s, [...(owners.get(s) ?? []), pkg]);
  }
  const out: MissingSurface[] = [];
  for (const [selector, packages] of owners) {
    const [prefix, rest = ""] = selector.split(":");
    const kind = PREFIX_TO_KIND[prefix as Prefix];
    const [group = "", name = ""] = rest.split(".");
    if (!kind) continue;
    const onChain = (ctx: RuntimeCtx) => ctx.groups(kind).includes(group);
    if (!onChain(live) && !onChain(candidate)) continue;
    if (candidate.entry(kind, group, name)) continue;
    out.push({ selector, packages, alsoMissingOnLive: !live.entry(kind, group, name) });
  }
  return out.sort(
    (a, b) => Number(a.alsoMissingOnLive) - Number(b.alsoMissingOnLive) || a.selector.localeCompare(b.selector),
  );
}

// ---------------------------------------------------------------------------
// One chain, end to end
// ---------------------------------------------------------------------------

export interface Side extends RuntimeVersion {
  metadataVersion: number;
  codeHash?: string;
}

export interface MetadataDiff {
  live: Side;
  candidate: Side;
  entries: EntryDiff[];
  extensions: PipelineDiff;
  missingSurfaces: MissingSurface[];
}

/** diffChain on metadata already decoded. */
export async function diffMetadata({
  liveMeta,
  candidateMeta,
  descriptor,
  bySdk = {},
}: {
  liveMeta: UnifiedMetadata;
  candidateMeta: UnifiedMetadata;
  descriptor: Descriptor | null;
  bySdk?: Record<string, string[]>;
}): Promise<MetadataDiff> {
  const live = runtimeCtx(liveMeta);
  const candidate = runtimeCtx(candidateMeta);
  const sdkRefs = new Set(Object.values(bySdk).flat());

  // What the SDK's own code reads goes first within each severity: a changed event
  // nobody decodes matters less than a call the SDK builds.
  const entries = descriptor
    ? diffEntries(await descriptorCtx(descriptor), live, candidate)
        .map((e) => ({ ...e, sdkRef: sdkRefs.has(e.selector) }))
        .sort(
          (a, b) =>
            (a.severity === b.severity ? Number(b.sdkRef) - Number(a.sdkRef) : 0) || bySeverityThenSelector(a, b),
        )
    : [];
  return {
    live: { ...runtimeVersion(liveMeta), metadataVersion: liveMeta.version },
    candidate: { ...runtimeVersion(candidateMeta), metadataVersion: candidateMeta.version },
    entries,
    extensions: diffPipelines(liveMeta, candidateMeta),
    missingSurfaces: missingSurfaces(bySdk, live, candidate),
  };
}

/**
 * @param liveCode       the runtime the fork runs
 * @param candidateCode  the runtime it is about to be upgraded to
 * @param descriptor     a PAPI descriptors export, or null when the SDK has none
 * @param bySdk          sdkSelectors() output
 */
export async function diffChain({
  liveCode,
  candidateCode,
  descriptor,
  bySdk = {},
}: {
  liveCode: Uint8Array;
  candidateCode: Uint8Array;
  descriptor: Descriptor | null;
  bySdk?: Record<string, string[]>;
}): Promise<MetadataDiff & { metadata: { live: Uint8Array; candidate: Uint8Array } }> {
  const liveBytes = metadataFromRuntime(liveCode);
  const candidateBytes = metadataFromRuntime(candidateCode);
  const diff = await diffMetadata({
    liveMeta: decodeMetadata(liveBytes),
    candidateMeta: decodeMetadata(candidateBytes),
    descriptor,
    bySdk,
  });
  return {
    ...diff,
    live: { ...diff.live, codeHash: blake2Hex(liveCode) },
    candidate: { ...diff.candidate, codeHash: blake2Hex(candidateCode) },
    metadata: { live: liveBytes, candidate: candidateBytes },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** chain -> RPC port, from the engine's config/ports.env. */
export function forkPorts(text: string): (chain: string) => string | undefined {
  const vars = Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((l) => l.split("="))
      .filter(([k, v]) => k && v),
  ) as Record<string, string>;
  return (chain) =>
    chain === "relay" ? vars.RELAY_ALICE_PORT : vars[`${chain.toUpperCase().replaceAll("-", "_")}_PORT`];
}

async function fetchCode(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_getStorage", params: [CODE_KEY] }),
    signal: AbortSignal.timeout(60_000),
  }).catch((error: Error & { cause?: { code?: string } }) => {
    throw new Error(`${url}: ${error.cause?.code ?? error.message}`);
  });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (!body.result) throw new Error(`${url}: no :code (${JSON.stringify(body.error ?? body).slice(0, 200)})`);
  return Buffer.from(body.result.replace(/^0x/, ""), "hex");
}

const readPlan = (file: string): Array<[string, string]> =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim().split("="))
    .filter((p): p is [string, string] => !!p[0] && !!p[1]);

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | undefined> } {
  const positional: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { positional, flags };
}

export interface ChainDiff extends Partial<MetadataDiff> {
  chain: string;
  pin: string | null;
  wasm: string;
  descriptor?: string | null;
  error?: string;
}

export interface Diff {
  network: string;
  sdk: Array<Omit<SdkPackage, "dir">>;
  descriptors: string | null;
  sdkSelectors: Record<string, string[]>;
  chains: ChainDiff[];
}

interface Manifest {
  network: string;
  chains?: Record<string, { runtime?: string }>;
}

export async function capture({
  manifest,
  plan,
  portOf,
  rpc = {},
  out,
  testsDir,
}: {
  manifest: Manifest;
  plan: Array<[string, string]>;
  portOf: (chain: string) => string | undefined | null;
  rpc?: Record<string, string>;
  out: string;
  testsDir: string;
}): Promise<Diff> {
  fs.mkdirSync(out, { recursive: true });
  const sdk = installedSdk(testsDir);
  const descriptorsPkg = sdk.find((p) => p.name === "@parity/product-sdk-descriptors");
  const bySdk = sdkSelectors(sdk);
  const result: Diff = {
    network: manifest.network,
    sdk: sdk.map(({ name, version, from, deps }) => ({ name, version, from, deps })),
    descriptors: descriptorsPkg ? `${descriptorsPkg.name}@${descriptorsPkg.version}` : null,
    sdkSelectors: bySdk,
    chains: [],
  };

  for (const [chain, wasm] of plan) {
    const row: ChainDiff = { chain, pin: manifest.chains?.[chain]?.runtime ?? null, wasm: path.basename(wasm) };
    try {
      const port = portOf(chain);
      const url = rpc[chain] ?? (port ? `http://127.0.0.1:${port}` : null);
      if (!url) throw new Error(`no RPC port known for ${chain}`);
      const name = descriptorsPkg ? descriptorChainFor(descriptorsPkg.dir, manifest.network, chain) : null;
      row.descriptor = name;
      const { metadata, ...diff } = await diffChain({
        liveCode: url.startsWith("http") ? await fetchCode(url) : fs.readFileSync(url),
        candidateCode: fs.readFileSync(wasm),
        descriptor: name && descriptorsPkg ? await loadDescriptor(descriptorsPkg.dir, name) : null,
        bySdk,
      });
      // The metadata goes to its own .scale files, not into the JSON.
      fs.writeFileSync(path.join(out, `${chain}.live.scale`), metadata.live);
      fs.writeFileSync(path.join(out, `${chain}.candidate.scale`), metadata.candidate);
      Object.assign(row, diff);
    } catch (error) {
      row.error = (error as Error).message;
    }
    result.chains.push(row);
  }
  fs.writeFileSync(path.join(out, "diff.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [mode, manifestFile, planFile] = positional;
  if (mode !== "capture" || !manifestFile || !planFile) {
    console.error(
      "usage: runtime-diff.ts capture <candidate-manifest.json> <upgrades.env> --out <dir> " +
        "[--ports ppn/config/ports.env] [--rpc chain=url|file,...] [--tests-dir packages/chain-tests]",
    );
    process.exit(2);
  }
  const rpc = Object.fromEntries(
    (flags.rpc ?? "")
      .split(",")
      .filter(Boolean)
      .map((p) => p.split("=")),
  ) as Record<string, string>;
  const result = await capture({
    manifest: JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Manifest,
    plan: fs.existsSync(planFile) ? readPlan(planFile) : [],
    portOf: flags.ports ? forkPorts(fs.readFileSync(flags.ports, "utf8")) : () => null,
    rpc,
    out: flags.out ?? "runtime-diff",
    testsDir: flags["tests-dir"] ?? "packages/chain-tests",
  });
  for (const c of result.chains) {
    if (c.error || !c.entries || !c.extensions) console.error(`${c.chain}: could not diff: ${c.error}`);
    else {
      const count = (s: Severity) => c.entries!.filter((e) => e.severity === s).length;
      console.error(
        `${c.chain}: ${c.live?.specVersion} -> ${c.candidate?.specVersion}; ${count("breaking")} breaking, ` +
          `${count("partial")} partial, ${count("additive")} additive SDK entries; extensions: ${c.extensions.summary}`,
      );
    }
  }
}
