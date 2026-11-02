// Entries (calls, storage, constants, events, runtime APIs, view functions) graded the
// way polkadot-api grades them at runtime: the SDK's descriptor against the live
// runtime, then against the candidate.

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
import { Tuple, Vector } from "@polkadot-api/substrate-bindings";
import type { UnifiedMetadata } from "./metadata.ts";

export type Kind = "storage" | "tx" | "events" | "constants" | "viewFns" | "apis";
export const KINDS: readonly Kind[] = ["storage", "tx", "events", "constants", "viewFns", "apis"];

// The selector prefix Runtime Watch uses for each kind: `query:People.People`.
export const PREFIX: Record<Kind, string> = {
  storage: "query",
  tx: "tx",
  events: "event",
  constants: "constant",
  viewFns: "view",
  apis: "api",
};
export const kindOf = (prefix: string): Kind | undefined => KINDS.find((kind) => PREFIX[kind] === prefix);

const LEVEL: Record<CompatibilityLevel, string> = {
  [CompatibilityLevel.Incompatible]: "Incompatible",
  [CompatibilityLevel.Partial]: "Partial",
  [CompatibilityLevel.BackwardsCompatible]: "BackwardsCompatible",
  [CompatibilityLevel.Identical]: "Identical",
};

/** One side of a comparison: a runtime, or the SDK's descriptor. */
export interface Ctx {
  node: (id: number) => TypedefNode;
  entry: (kind: Kind, group: string, name: string) => EntryPoint | undefined;
}

export interface RuntimeCtx extends Ctx {
  hasGroup: (kind: Kind, group: string) => boolean;
}

export interface DescriptorCtx extends Ctx {
  names: (kind: Kind) => [string, string][];
}

/**
 * The view of a runtime polkadot-api builds for its own compatibility checks
 * (polkadot-api/src/compatibility/compat-ctx.js).
 */
export function runtimeCtx(metadata: UnifiedMetadata): RuntimeCtx {
  const lookup = getLookupFn(metadata);
  const nodes = new Map<number, TypedefNode>();
  const node = (id: number): TypedefNode => {
    const known = nodes.get(id);
    if (known) return known;
    const created = mapLookupToTypedef(lookup(id));
    nodes.set(id, created);
    return created;
  };
  const variants = (ref: { type: number } | undefined) => {
    const entry = ref && lookup(ref.type);
    return entry?.type === "enum" ? Object.entries(entry.value) : [];
  };

  const entries: Record<Kind, Map<string, Map<string, EntryPoint>>> = {
    storage: new Map(),
    tx: new Map(),
    events: new Map(),
    constants: new Map(),
    viewFns: new Map(),
    apis: new Map(),
  };
  for (const p of metadata.pallets) {
    const items = p.storage?.items ?? [];
    entries.storage.set(p.name, new Map(items.map((item) => [item.name, storageEntryPoint(item)])));
    const calls = variants(p.calls).map(([name, v]) => [name, { args: enumValueEntryPointNode(v), values: voidEntryPointNode }] as const);
    entries.tx.set(p.name, new Map(calls));
    const events = variants(p.events).map(([name, v]) => [name, { args: voidEntryPointNode, values: enumValueEntryPointNode(v) }] as const);
    entries.events.set(p.name, new Map(events));
    entries.constants.set(p.name, new Map(p.constants.map((c) => [c.name, singleValueEntryPoint(c.type)])));
    const viewFns = "viewFns" in p ? p.viewFns : [];
    entries.viewFns.set(p.name, new Map(viewFns.map((fn) => [fn.name, runtimeCallEntryPoint(fn)])));
  }
  for (const api of metadata.apis) {
    entries.apis.set(api.name, new Map(api.methods.map((m) => [m.name, runtimeCallEntryPoint(m)])));
  }
  return {
    node,
    entry: (kind, group, name) => entries[kind].get(group)?.get(name),
    hasGroup: (kind, group) => entries[kind].has(group),
  };
}

/** The part of a PAPI descriptors export the comparison reads. */
export interface Descriptor {
  metadataTypes: Promise<Uint8Array> | Uint8Array;
  descriptors: Promise<Partial<Record<Kind, Record<string, Record<string, number>>>>>;
  getMetadata: () => Promise<Uint8Array>;
}

export async function descriptorCtx(descriptor: Descriptor): Promise<DescriptorCtx> {
  const [types, values] = await Promise.all([descriptor.metadataTypes, descriptor.descriptors]);
  const [entryPoints, typedefs] = Tuple(Vector(EntryPointCodec), Vector(TypedefCodec)).dec(types);
  return {
    node: (id) => {
      const found = typedefs[id];
      if (!found) throw new Error(`the descriptor has no type ${id}`);
      return found;
    },
    entry: (kind, group, name) => {
      const index = values[kind]?.[group]?.[name];
      return index === undefined ? undefined : entryPoints[index];
    },
    names: (kind) =>
      Object.entries(values[kind] ?? {}).flatMap(([group, members]) =>
        Object.keys(members).map((name): [string, string] => [group, name]),
      ),
  };
}

/**
 * How well the SDK's descriptor fits a runtime, as polkadot-api's `isCompatible`
 * decides it: a call needs its arguments to encode, a constant or event its value to
 * decode, storage and runtime APIs both.
 */
export function sdkLevel(
  kind: Kind,
  sdk: Ctx,
  sdkEntry: EntryPoint,
  runtime: Ctx,
  group: string,
  name: string,
): CompatibilityLevel {
  const runtimeEntry = runtime.entry(kind, group, name);
  if (!runtimeEntry) return CompatibilityLevel.Incompatible;
  const result = entryPointsAreCompatible(sdkEntry, sdk.node, runtimeEntry, runtime.node, new Map());
  if (kind === "tx") return result.args.level;
  if (kind === "constants" || kind === "events") return result.values.level;
  return result.args.level < result.values.level ? result.args.level : result.values.level;
}

/**
 * Breaking: the candidate fits the SDK worse than live did, and badly enough that
 * polkadot-api refuses the entry for at least some values (below
 * BackwardsCompatible). Anything else is additive. An entry the SDK already could not
 * use on live stays additive: this run did not cause it.
 */
export const isBreaking = (live: CompatibilityLevel, candidate: CompatibilityLevel): boolean =>
  candidate < live && candidate < CompatibilityLevel.BackwardsCompatible;

export interface ChangePath {
  side: "args" | "value";
  path: string;
}

export interface EntryDiff {
  selector: string;
  change: "added" | "removed" | "changed";
  severity: "breaking" | "additive";
  sdk: { live: string; candidate: string };
  paths: ChangePath[];
  /** The SDK's own code reads it, not only its descriptor. */
  sdkRef: boolean;
}

function changedPaths(a: EntryPoint, live: Ctx, b: EntryPoint, candidate: Ctx): ChangePath[] | null {
  const result = entryPointsAreCompatible(a, live.node, b, candidate.node, new Map(), true);
  const identical = CompatibilityLevel.Identical;
  if (result.args.level === identical && result.values.level === identical) return null;
  const paths: ChangePath[] = [
    ...result.args.changes.map((c) => ({ side: "args" as const, path: c.path })),
    ...result.values.changes.map((c) => ({ side: "value" as const, path: c.path })),
  ];
  // PAPI reports a change at every level of the tree it passes through; the deepest
  // one is the useful one.
  return paths
    .filter((p) => !paths.some((q) => q !== p && q.side === p.side && q.path.startsWith(`${p.path}.`)))
    .slice(0, 8);
}

/**
 * Every descriptor entry the two runtimes disagree on, graded for the SDK. Breaking
 * first, then what the SDK's own code reads: a changed event nobody decodes matters
 * less than a call the SDK builds.
 */
export function diffEntries(sdk: DescriptorCtx, live: Ctx, candidate: Ctx, sdkRefs: Set<string>): EntryDiff[] {
  const out: EntryDiff[] = [];
  for (const kind of KINDS) {
    for (const [group, name] of sdk.names(kind)) {
      const sdkEntry = sdk.entry(kind, group, name);
      const a = live.entry(kind, group, name);
      const b = candidate.entry(kind, group, name);
      if (!sdkEntry || (!a && !b)) continue;
      const paths = a && b ? changedPaths(a, live, b, candidate) : [];
      if (!paths) continue;
      const before = sdkLevel(kind, sdk, sdkEntry, live, group, name);
      const after = sdkLevel(kind, sdk, sdkEntry, candidate, group, name);
      const selector = `${PREFIX[kind]}:${group}.${name}`;
      out.push({
        selector,
        change: !b ? "removed" : !a ? "added" : "changed",
        severity: isBreaking(before, after) ? "breaking" : "additive",
        sdk: { live: LEVEL[before], candidate: LEVEL[after] },
        paths,
        sdkRef: sdkRefs.has(selector),
      });
    }
  }
  return out.sort(
    (x, y) =>
      Number(y.severity === "breaking") - Number(x.severity === "breaking") ||
      Number(y.sdkRef) - Number(x.sdkRef) ||
      x.selector.localeCompare(y.selector),
  );
}
