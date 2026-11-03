import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import SdkDescriptor from "../descriptor/index.ts";
import buildRequirements from "../requirements/index.ts";
import type { Requirements } from "../requirements/types.ts";
import Runtime from "../runtime/index.ts";
import SdkUsage from "../usage/index.ts";
import check from "./index.ts";

// Against fixtures/ (see fixtures/README.md): People, read by SDK 0.42.0. Skipped without
// them. Live against the candidate is buildReport's, in report/test.ts.
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("check on the fixtures", { skip }, () => {
  const packages = path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages");
  const people = (release: string) =>
    new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, "next_people_paseo_runtime.compact.compressed.wasm")));

  /** People's requirements for what `usage` reads: by default, everything the SDK reads. */
  const requirementsOf = async (usage = SdkUsage.scan(packages)): Promise<Requirements> => {
    const descriptor = await SdkDescriptor.load(path.join(packages, "descriptors", "chains", "paseo-individuality"));
    const [requirements] = buildRequirements({ individuality: descriptor }, usage).chains;
    assert.ok(requirements);
    return requirements;
  };

  it("grades one runtime on its own, without live to compare against", async () => {
    const r = check(await requirementsOf(), people("0.3.1"));
    assert.equal(r.runtime.specVersion, 3001000);
    assert.deepEqual(
      r.entries.filter((e) => e.level === "Missing").map((e) => e.requirement.selector),
      ["constants:Score.Suffix"],
    );
    // D signs with v1, which v0.3.1 does not have yet.
    assert.deepEqual(
      r.pipelines.map((p) => `v${p.version} ${p.level} ${p.actual === null ? "absent" : "present"}`),
      ["v0 Incompatible present", "v1 Missing absent"],
    );
  });

  it("skips the pipelines on a chain the SDK uses no transactions on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/reader" }));
    fs.writeFileSync(path.join(dir, "src", "read.ts"), "chain.individuality.query.Game.Players;");
    const r = check(await requirementsOf(SdkUsage.scan(dir)), people("0.3.4"));
    assert.deepEqual(r.pipelines, []);
    assert.deepEqual(
      r.entries.map((e) => `${e.requirement.selector} ${e.level}`),
      ["query:Game.Players Identical"],
    );
  });
});
