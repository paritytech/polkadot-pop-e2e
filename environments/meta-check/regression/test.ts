import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntryCheck, PipelineCheck, RuntimeCheck } from "../check/types.ts";
import type { Requirement } from "../requirements/types.ts";
import type { Level, Selector } from "../types.ts";
import regression, { verdict } from "./index.ts";

describe("verdict", () => {
  const cases: [Level, Level, string][] = [
    ["Identical", "BackwardsCompatible", "ok"],
    ["Identical", "Present", "ok"],
    ["Partial", "Identical", "ok"],
    ["BackwardsCompatible", "Partial", "breaking"], // a new Partial breaks
    ["Partial", "Partial", "pre-existing"], // an old one does not
    ["Identical", "Incompatible", "breaking"],
    ["Present", "Missing", "breaking"],
    ["Incompatible", "Missing", "pre-existing"],
    ["Incompatible", "Partial", "pre-existing"],
    ["Missing", "Missing", "pre-existing"],
  ];
  for (const [before, after, expected] of cases) {
    it(`${before} -> ${after} is ${expected}`, () => assert.equal(verdict(before, after), expected));
  }

  it("lets an optional entry go missing", async () => {
    assert.equal(verdict("Identical", "Missing", true), "ok");
    assert.equal(verdict("Identical", "Incompatible", true), "breaking");
  });
});

// ── Hand-built checks ────────────────────────────────────

const requirement = (selector: Selector, optional = false): Requirement => ({
  selector,
  direction: "both",
  expected: null,
  uses: [],
  placedBy: "chain",
  optional,
});

const pipelineCheck = (version: number, level: Level, overrides: Partial<PipelineCheck> = {}): PipelineCheck => ({
  version,
  expected: ["A", "B"],
  actual: ["A", "B"],
  level,
  retyped: [],
  ...overrides,
});

const runtimeCheck = (specVersion: number, entries: EntryCheck[], pipelines: PipelineCheck[] = []): RuntimeCheck => ({
  chain: "individuality",
  descriptor: { chain: "paseo-individuality", codeHash: "0x00" },
  runtime: { specName: "people", specVersion, transactionVersion: 1, codeHash: `0x${specVersion}` },
  entries,
  pipelines,
});

describe("regression", () => {
  const players = requirement("query:Game.Players");
  const suffix = requirement("constants:Score.Suffix", true);
  const versions = (onLive: RuntimeCheck, onCandidate: RuntimeCheck) =>
    regression(onLive, onCandidate).pipelines.map((p) => `v${p.version} ${p.before}->${p.after} ${p.verdict}`);

  it("pairs each requirement's grade on live with its grade on the candidate", () => {
    const { entries } = regression(
      runtimeCheck(1, [
        { requirement: suffix, level: "Identical" },
        { requirement: players, level: "Identical" },
      ]),
      runtimeCheck(2, [
        { requirement: suffix, level: "Missing" },
        { requirement: players, level: "Partial" },
      ]),
    );
    assert.deepEqual(
      entries.map((e) => `${e.requirement.selector} ${e.before}->${e.after} ${e.verdict}`),
      ["constants:Score.Suffix Identical->Missing ok", "query:Game.Players Identical->Partial breaking"],
    );
  });

  it("grades a version only one runtime has as Missing on the other", () => {
    // The candidate drops v0, which D signs with, and adds v1, which D does not.
    const onLive = runtimeCheck(1, [], [pipelineCheck(0, "Identical")]);
    const onCandidate = runtimeCheck(2, [], [pipelineCheck(1, "Present", { expected: null, actual: ["C"] })]);
    assert.deepEqual(versions(onLive, onCandidate), ["v0 Identical->Missing breaking", "v1 Missing->Present ok"]);
  });

  it("lets a version D does not sign with disappear", () => {
    const onLive = runtimeCheck(1, [], [pipelineCheck(0, "Present", { expected: null })]);
    assert.deepEqual(versions(onLive, runtimeCheck(2, [])), ["v0 Present->Missing ok"]);
  });

  it("orders the versions, whichever runtime has them", () => {
    const onLive = runtimeCheck(1, [], [pipelineCheck(1, "Identical")]);
    const onCandidate = runtimeCheck(2, [], [pipelineCheck(1, "Identical"), pipelineCheck(0, "Present", { expected: null })]);
    assert.deepEqual(versions(onLive, onCandidate), ["v0 Missing->Present ok", "v1 Identical->Identical ok"]);
  });

  it("refuses checks of different requirements or chains", () => {
    const onLive = runtimeCheck(1, [{ requirement: players, level: "Identical" }]);
    const different = /checked against different requirements/;
    assert.throws(() => regression(onLive, runtimeCheck(2, [])), different);
    assert.throws(() => regression(onLive, runtimeCheck(2, [{ requirement: suffix, level: "Identical" }])), different);
    assert.throws(() => regression(onLive, { ...onLive, chain: "assetHub" }), different);
    const longer = runtimeCheck(2, [
      { requirement: players, level: "Identical" },
      { requirement: suffix, level: "Identical" },
    ]);
    assert.throws(() => regression(onLive, longer), different);
  });
});
