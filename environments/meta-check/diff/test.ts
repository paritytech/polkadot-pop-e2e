import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import SdkDescriptor from "../descriptor/index.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import SdkUsage from "../usage/index.ts";
import diff from "./index.ts";

// Against fixtures/ (see fixtures/README.md): People, read by SDK 0.28.0. Skipped without them.
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("diff on the fixtures", { skip }, () => {
  const packages = path.join(FIXTURES, "product-sdk-0.28.0", "product-sdk", "packages");
  const wasm = (release: string) =>
    new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, "next_people_paseo_runtime.compact.compressed.wasm")));
  const requirements = async () => {
    const descriptor = await SdkDescriptor.load(path.join(packages, "descriptors", "chains", "paseo-individuality"));
    const [people] = buildRequirements({ individuality: descriptor }, SdkUsage.scan(packages)).chains;
    assert.ok(people);
    return people;
  };

  it("says where the entries the SDK reads changed, whether or not the SDK minds", async () => {
    const changes = diff(await requirements(), wasm("0.3.1"), wasm("0.3.4"));
    assert.equal(changes.chain, "individuality");
    // Sudo.sudo breaks this SDK; Airdrop.Events only became BackwardsCompatible.
    assert.deepEqual(
      changes.entries.map((e) => `${e.selector} ${e.changedAt.join(",")}`),
      ["query:Airdrop.Events value.info", "tx:Sudo.sudo args.call"],
    );
  });

  it("finds no change between a runtime and itself", async () => {
    const runtime = wasm("0.3.4");
    assert.deepEqual(diff(await requirements(), runtime, runtime).entries, []);
  });
});
