// How well a runtime fits what D expects, the way polkadot-api decides it at runtime:
// per entry (Rules 1 and 2) and per extension pipeline (Rule 3).

import {
  CompatibilityLevel,
  entryPointsAreCompatible,
  voidEntryPointNode,
  type CompatibilityCache,
  type EntryPoint,
} from "@polkadot-api/metadata-compatibility";
import { worse } from "../level.ts";
import type MetadataView from "../metadata-view/index.ts";
import type { Level, Requirement } from "../types.ts";

const LEVEL: Record<CompatibilityLevel, Level> = {
  [CompatibilityLevel.Incompatible]: "Incompatible",
  [CompatibilityLevel.Partial]: "Partial",
  [CompatibilityLevel.BackwardsCompatible]: "BackwardsCompatible",
  [CompatibilityLevel.Identical]: "Identical",
};

const nodes = (view: MetadataView) => (id: number) => view.node(id);

/**
 * D's expectation for one requirement against a runtime. The side graded follows who
 * encodes: the SDK encodes a call's arguments, decodes an event's or a constant's
 * value, and does both for storage and runtime calls.
 */
export function entryLevel(
  requirement: Requirement,
  descriptor: MetadataView,
  runtime: MetadataView,
  cache: CompatibilityCache,
): Level {
  const actual = runtime.entry(requirement.selector);
  if (!actual) return "Missing";
  if (!requirement.expected) return "Present";
  const { args, values } = entryPointsAreCompatible(
    requirement.expected.shape,
    nodes(descriptor),
    actual.shape,
    nodes(runtime),
    cache,
  );
  if (requirement.direction === "encode") return LEVEL[args.level];
  if (requirement.direction === "decode") return LEVEL[values.level];
  return worse(LEVEL[args.level], LEVEL[values.level]);
}

type Extension = MetadataView["metadata"]["extrinsic"]["extensionsByVersion"][number][number];

/** The signer encodes both an extension's explicit value and its implicit (additional signed) one. */
const encodes = (typeId: number): EntryPoint => ({
  args: { type: "lookup", value: typeId },
  values: voidEntryPointNode,
});

/**
 * D's pipeline for one extension version against a runtime's. The signer must build
 * exactly D's list in D's order, so any added, removed or reordered extension is
 * Incompatible; with the same list, each extension's types are graded like a call's
 * arguments. `retyped` names the extensions whose types are not Identical.
 */
export function pipelineLevel(
  version: number,
  descriptor: MetadataView,
  runtime: MetadataView,
  cache: CompatibilityCache,
): { level: Level; retyped: string[] } {
  const expected = descriptor.metadata.extrinsic.extensionsByVersion[version];
  const actual = runtime.metadata.extrinsic.extensionsByVersion[version];
  if (!expected) return { level: actual ? "Present" : "Missing", retyped: [] };
  if (!actual) return { level: "Missing", retyped: [] };
  const ids = (list: Extension[]) => list.map((extension) => extension.identifier).join();
  if (ids(expected) !== ids(actual)) return { level: "Incompatible", retyped: [] };

  let level: Level = "Identical";
  const retyped: string[] = [];
  expected.forEach((extension, index) => {
    const other = actual[index];
    if (!other) return;
    const grade = (from: number, to: number) =>
      LEVEL[entryPointsAreCompatible(encodes(from), nodes(descriptor), encodes(to), nodes(runtime), cache).args.level];
    const extensionLevel = worse(grade(extension.type, other.type), grade(extension.additionalSigned, other.additionalSigned));
    if (extensionLevel !== "Identical") retyped.push(extension.identifier);
    level = worse(level, extensionLevel);
  });
  return { level, retyped };
}
