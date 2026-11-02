// diff(R, A, A'): what changed between live (A) and the candidate (A') within what the
// SDK uses: the entries R names and, where the SDK uses transactions, the extension
// pipelines and the extrinsic versions. It says what changed in how they encode, not
// whether the SDK minds: that is check's and regression's.

import type MetadataView from "../metadata-view/index.ts";
import type Runtime from "../runtime/index.ts";
import type {
  ChangeStatus,
  Encoding,
  EntryChange,
  ExtensionChange,
  ExtrinsicVersionChange,
  PipelineChange,
  Requirements,
  RuntimeDiff,
  Selector,
  TypeChange,
} from "../types.ts";
import compareTypes, { MAX_TYPE_CHANGES } from "./compare.ts";

type Changes = ReturnType<typeof compareTypes>;

/**
 * Each side's changes, up to the limit for each: one side with many (a call's arguments)
 * does not push out the other (its result). `truncated` when any side had more.
 */
const listed = (...sides: TypeChange[][]) => ({
  types: sides.flatMap((side) => side.slice(0, MAX_TYPE_CHANGES)),
  truncated: sides.some((side) => side.length > MAX_TYPE_CHANGES),
});

/** What a runtime without the entry encodes for it. */
const NOTHING: Encoding = { args: null, value: null };

/** How one entry R uses differs between live and the candidate; null when it does not. */
function entryChange(selector: Selector, live: Runtime, candidate: Runtime, changes: Changes): EntryChange | null {
  const onLive = live.entry(selector)?.encoding;
  const onCandidate = candidate.entry(selector)?.encoding;
  const before = onLive ?? NOTHING;
  const after = onCandidate ?? NOTHING;
  const { types, truncated } = listed(changes("args", before.args, after.args), changes("value", before.value, after.value));

  let status: ChangeStatus;
  if (onLive && onCandidate) {
    // On both: a change only where they encode differently.
    if (types.length === 0) return null;
    status = "changed";
  } else if (onLive) {
    status = "removed";
  } else if (onCandidate) {
    status = "added";
  } else {
    return null;
  }
  // Added or removed is a change even with nothing to encode, as a call without arguments.
  return { selector, status, types, truncated };
}

type Extension = MetadataView["metadata"]["extrinsic"]["extensionsByVersion"][number][number];

/** What `list` has more of than `other`: each identifier as many times more as it has it. */
function beyond(list: readonly string[], other: readonly string[]): string[] {
  const left = [...other];
  return list.filter((id) => {
    const at = left.indexOf(id);
    if (at >= 0) left.splice(at, 1);
    return at < 0;
  });
}

/** How many of `a`'s identifiers `b` has in the same order, others between: their longest common subsequence. */
function inOrder(a: readonly string[], b: readonly string[]): number {
  let row = Array<number>(b.length + 1).fill(0);
  for (const id of a) {
    const next = [0];
    b.forEach((other, j) => next.push(id === other ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0)));
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * From one extension list to another: the identifiers added and removed, each as often as
 * one list has it more than the other (nothing stops a version listing one twice), and
 * whether those both keep are in another order.
 */
export function listChange(before: readonly string[], after: readonly string[]) {
  const added = beyond(after, before);
  const removed = beyond(before, after);
  return { added, removed, reordered: inOrder(before, after) < before.length - removed.length };
}

/**
 * Each extension version A or A' has, where it differs: the extensions added, removed or
 * reordered, and those both keep whose types differ.
 */
function pipelineChanges(live: Runtime, candidate: Runtime, changes: Changes): PipelineChange[] {
  const versions = [...new Set([live, candidate].flatMap((view) => Object.keys(view.pipelines).map(Number)))];
  return versions
    .sort((a, b) => a - b)
    .flatMap((version): PipelineChange[] => {
      const before = live.pipelines[version] ?? null;
      const after = candidate.pipelines[version] ?? null;
      const { added, removed, reordered } = listChange(before ?? [], after ?? []);

      const extensions = (view: MetadataView): Extension[] => view.metadata.extrinsic.extensionsByVersion[version] ?? [];
      const retyped = extensions(live).flatMap((extension, index, list): ExtensionChange[] => {
        // Listed twice, the first on live is compared with the first on the candidate, and so on.
        const same = ({ identifier }: Extension) => identifier === extension.identifier;
        const other = extensions(candidate).filter(same)[list.slice(0, index).filter(same).length];
        if (!other) return [];
        const { types, truncated } = listed(
          changes("type", live.lookup(extension.type), candidate.lookup(other.type)),
          changes("additionalSigned", live.lookup(extension.additionalSigned), candidate.lookup(other.additionalSigned)),
        );
        return types.length > 0 ? [{ identifier: extension.identifier, types, truncated }] : [];
      });

      const status = !before ? "added" : !after ? "removed" : "changed";
      if (status === "changed" && added.length + removed.length + retyped.length === 0 && !reordered) return [];
      return [{ version, status, live: before, candidate: after, added, removed, reordered, retyped }];
    });
}

/** The extrinsic format versions A and A' accept, when they differ. */
function extrinsicVersionChange(live: Runtime, candidate: Runtime): ExtrinsicVersionChange | null {
  const before = [...live.metadata.extrinsic.version].sort((a, b) => a - b);
  const after = [...candidate.metadata.extrinsic.version].sort((a, b) => a - b);
  if (before.join() === after.join()) return null;
  return {
    live: before,
    candidate: after,
    added: after.filter((version) => !before.includes(version)),
    removed: before.filter((version) => !after.includes(version)),
  };
}

export default function diff(requirements: Requirements, live: Runtime, candidate: Runtime): RuntimeDiff {
  const changes = compareTypes(live, candidate);
  const { usesTransactions } = requirements;
  return {
    chain: requirements.chain,
    entries: requirements.entries.flatMap(({ selector }) => entryChange(selector, live, candidate, changes) ?? []),
    pipelines: usesTransactions ? pipelineChanges(live, candidate, changes) : [],
    extrinsicVersions: usesTransactions ? extrinsicVersionChange(live, candidate) : null,
  };
}
