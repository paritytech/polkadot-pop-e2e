// Transaction extension pipelines, per extension version.

import { CompatibilityLevel, entryPointsAreCompatible, type EntryPoint } from "@polkadot-api/metadata-compatibility";
import { runtimeCtx } from "./entries.ts";
import type { UnifiedMetadata } from "./metadata.ts";

type Extension = UnifiedMetadata["extrinsic"]["extensionsByVersion"][number][number];

export interface PipelineRow {
  version: number;
  before: string[];
  after: string[];
  status: "same" | "changed" | "added" | "removed";
  breaking: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
  retyped: string[];
}

export interface PipelineDiff {
  versions: PipelineRow[];
  moved: { identifier: string; from: number[]; to: number[] }[];
  summary: string;
  extrinsicVersions: { removed: number[]; added: number[] };
}

const ids = (list: Extension[] | undefined): string[] => (list ?? []).map((e) => e.identifier);

/**
 * What was added, removed or reordered in each version, and which extensions kept
 * their name but changed type. A changed or removed pipeline is breaking: a signer
 * built for it produces transactions the candidate rejects. A new version is not.
 * `moved` names extensions that left one version for another, which is how "the
 * person extensions moved from v0 to a new v1" reads.
 */
export function diffPipelines(liveMeta: UnifiedMetadata, candidateMeta: UnifiedMetadata): PipelineDiff {
  const live = liveMeta.extrinsic.extensionsByVersion;
  const candidate = candidateMeta.extrinsic.extensionsByVersion;
  const liveCtx = runtimeCtx(liveMeta);
  const candidateCtx = runtimeCtx(candidateMeta);

  const typeChanged = (a: Extension, b: Extension | undefined): boolean => {
    if (!b) return false;
    const node = (e: Extension): EntryPoint => ({
      args: { type: "lookup", value: e.type },
      values: { type: "lookup", value: e.additionalSigned },
    });
    const r = entryPointsAreCompatible(node(a), liveCtx.node, node(b), candidateCtx.node, new Map());
    return r.args.level !== CompatibilityLevel.Identical || r.values.level !== CompatibilityLevel.Identical;
  };

  const versions = [...new Set([...Object.keys(live), ...Object.keys(candidate)].map(Number))].sort((a, b) => a - b);
  const rows = versions.map((version): PipelineRow => {
    const before = live[version];
    const after = candidate[version];
    const row = { version, before: ids(before), after: ids(after), added: [], removed: [], reordered: false, retyped: [] };
    if (!before) return { ...row, status: "added", breaking: false };
    if (!after) return { ...row, status: "removed", breaking: true };
    const added = row.after.filter((id) => !row.before.includes(id));
    const removed = row.before.filter((id) => !row.after.includes(id));
    const common = row.before.filter((id) => row.after.includes(id));
    const reordered = common.join() !== row.after.filter((id) => row.before.includes(id)).join();
    const retyped = before
      .filter((e) => common.includes(e.identifier))
      .filter((e) => typeChanged(e, after.find((x) => x.identifier === e.identifier)))
      .map((e) => e.identifier);
    const changed = added.length > 0 || removed.length > 0 || reordered || retyped.length > 0;
    return { ...row, status: changed ? "changed" : "same", breaking: changed, added, removed, reordered, retyped };
  });

  const versionsOf = (pipelines: Record<number, Extension[]>, id: string): number[] =>
    Object.entries(pipelines)
      .filter(([, list]) => ids(list).includes(id))
      .map(([v]) => Number(v));
  const moved = [...new Set(Object.values(live).flatMap(ids))]
    .map((id) => ({ identifier: id, from: versionsOf(live, id), to: versionsOf(candidate, id) }))
    .filter((m) => m.from.some((v) => !m.to.includes(v)) && m.to.some((v) => !m.from.includes(v)));

  const liveX = [...liveMeta.extrinsic.version];
  const candidateX = [...candidateMeta.extrinsic.version];
  return {
    versions: rows,
    moved,
    summary: pipelineSummary(rows, moved),
    extrinsicVersions: {
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
  const routes = new Map<string, string[]>();
  for (const m of moved) {
    const route = `v${m.from.join("+v")} to v${m.to.join("+v")}`;
    routes.set(route, [...(routes.get(route) ?? []), m.identifier]);
  }
  for (const [route, list] of routes) parts.push(`${list.join(", ")} moved from ${route}`);
  // A moved extension is already said; listing it again as gained and lost buries the
  // rest of the change.
  const wasMoved = new Set(moved.map((m) => m.identifier));
  for (const r of rows.filter((row) => row.status === "changed")) {
    const added = r.added.filter((id) => !wasMoved.has(id));
    const removed = r.removed.filter((id) => !wasMoved.has(id));
    const bits = [
      added.length ? `gained ${added.join(", ")}` : "",
      removed.length ? `lost ${removed.join(", ")}` : "",
      r.reordered ? "reordered" : "",
      r.retyped.length ? `${r.retyped.join(", ")} changed type` : "",
    ].filter(Boolean);
    if (bits.length) parts.push(`v${r.version} ${bits.join("; ")}`);
  }
  return parts.length ? `${parts.join(". ")}.` : "No change.";
}
