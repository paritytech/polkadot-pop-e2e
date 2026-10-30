// Runtime against the release runtimes in fixtures/ (see fixtures/README.md); skipped without them.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import SdkDescriptor from "../descriptor/index.ts";
import Runtime from "./index.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("Runtime", { skip }, () => {
  const load = (release: string, chain: "people" | "asset_hub") =>
    new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, `next_${chain}_paseo_runtime.compact.compressed.wasm`)));

  it("reads the version and the code hash", () => {
    assert.deepEqual(load("0.3.4", "people").version, {
      specName: "next-people-paseo",
      specVersion: 3004000,
      transactionVersion: 6,
      codeHash: "0x69e7126f098bdf708302e52b892fd76c5d2477627bce47cbfcee7fcd5db17871",
    });
    assert.deepEqual(
      { ...load("0.3.1", "asset_hub").version, codeHash: undefined },
      { specName: "next-asset-hub-paseo", specVersion: 3001000, transactionVersion: 21, codeHash: undefined },
    );
  });

  it("has the code hash D records for the runtime it was generated from", () => {
    const descriptor = SdkDescriptor.load(
      path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages", "descriptors", "chains", "paseo-asset-hub"),
    );
    assert.equal(load("0.3.4", "asset_hub").version.codeHash, descriptor.codeHash);
  });

  it("lists entries and pipelines like any metadata: the person extensions moved to a new v1 in 0.3.4", () => {
    const live = load("0.3.1", "people");
    const candidate = load("0.3.4", "people");
    assert.ok(candidate.entry("tx:Game.report"));
    assert.deepEqual(Object.keys(live.pipelines), ["0"]);
    assert.deepEqual(Object.keys(candidate.pipelines), ["0", "1"]);
    assert.ok(live.pipelines[0]?.includes("AsPerson"));
    assert.ok(candidate.pipelines[1]?.includes("AsPerson"));
  });

  it("refuses bytes that are not a runtime", () => {
    assert.throws(() => new Runtime(new Uint8Array([1, 2, 3])));
  });
});
