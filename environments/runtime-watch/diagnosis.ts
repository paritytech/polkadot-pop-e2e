// Copied from Runtime Watch: paritytech/velocity, runtime-watch/src/diagnosis.ts at
// f22450a (2026-10-19), with known-breaks.json next to it unchanged.
//
// Changes from the original:
// - pipelineChange takes the two pipeline maps, not Runtime Watch's status entries.
// - matchKnownBreak takes test errors. A test error wraps the SDK message, so a known
//   break matches when an error contains its canaryError, not only when it is equal.
// - pipelineChange returns null when live already has the candidate's newest
//   pipeline version. The original compares the newest live pipeline with the
//   candidate's first and last, so two runtimes that both have v0 and v1 read as
//   "moved from pipeline v1 to a new pipeline v1".
//
// Not copied: diagnoseEntry and diagnosisMarkdown. They describe Runtime Watch's
// four canary paths, which the gate does not run.

import { readFileSync } from "node:fs";

export interface KnownBreak {
  id: string;
  canaryError: string;
  scope: {
    sdkVersion: { maxExclusive: string };
    pipelineChange: {
      beforeVersions: string[];
      afterVersions: string[];
      moved: string[];
    };
  };
  explanation: string;
  fix: string[];
  tracking: Array<{ label: string; url: string }>;
}

export interface PipelineChange {
  summary: string;
  beforeVersions: string[];
  afterVersions: string[];
  moved: string[];
  before: string[];
  after: Record<string, string[]>;
}

export const knownBreaks = JSON.parse(
  readFileSync(new URL("./known-breaks.json", import.meta.url), "utf8"),
) as KnownBreak[];

const orderedVersions = (pipelines: Record<string, string[]>): string[] =>
  Object.keys(pipelines).sort((left, right) => Number(left) - Number(right));

export function pipelineChange(
  baselinePipelines: Record<string, string[]>,
  candidatePipelines: Record<string, string[]>,
): PipelineChange | null {
  const beforeVersions = orderedVersions(baselinePipelines);
  const afterVersions = orderedVersions(candidatePipelines);
  if (beforeVersions.length === 0 || afterVersions.length < 2) return null;
  if (beforeVersions.includes(afterVersions.at(-1)!)) return null;
  const before = baselinePipelines[beforeVersions.at(-1)!] ?? [];
  const plain = candidatePipelines[afterVersions[0]!] ?? [];
  const person = candidatePipelines[afterVersions.at(-1)!] ?? [];
  const moved = before.filter((identifier) => !plain.includes(identifier) && person.includes(identifier));
  const addedToPlain = plain.filter((identifier) => !before.includes(identifier));
  if (moved.length === 0) return null;
  const additions = addedToPlain.length > 0 ? `; v${afterVersions[0]} gained ${addedToPlain.join(", ")}` : "";
  return {
    summary: `The person extensions (${moved.join(", ")}) moved from pipeline v${beforeVersions.at(-1)} to a new pipeline v${afterVersions.at(-1)}${additions}.`,
    beforeVersions,
    afterVersions,
    moved,
    before,
    after: Object.fromEntries(afterVersions.map((version) => [version, candidatePipelines[version] ?? []])),
  };
}

const versionParts = (version: string): number[] =>
  version
    .split("-", 1)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

export function versionLessThan(version: string, upperBound: string): boolean {
  const left = versionParts(version);
  const right = versionParts(upperBound);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

const sameMembers = (left: string[], right: string[]): boolean =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function matchesKnownBreak(
  candidate: KnownBreak,
  errors: string[],
  pipeline: PipelineChange | null,
  sdkVersion: string,
): boolean {
  if (!errors.some((error) => error.includes(candidate.canaryError)) || !pipeline) return false;
  const expected = candidate.scope.pipelineChange;
  return (
    versionLessThan(sdkVersion, candidate.scope.sdkVersion.maxExclusive) &&
    sameMembers(pipeline.beforeVersions, expected.beforeVersions) &&
    sameMembers(pipeline.afterVersions, expected.afterVersions) &&
    expected.moved.every((identifier) => pipeline.moved.includes(identifier))
  );
}

/** The catalogued break these errors, this pipeline change and this SDK version show. */
export function matchKnownBreak(
  errors: string[],
  pipeline: PipelineChange | null,
  sdkVersion: string,
  catalogue: KnownBreak[] = knownBreaks,
): KnownBreak | null {
  return catalogue.find((candidate) => matchesKnownBreak(candidate, errors, pipeline, sdkVersion)) ?? null;
}
