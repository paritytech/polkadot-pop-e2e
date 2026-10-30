// SdkDescriptor against the two product-sdk versions in fixtures/ (see fixtures/README.md).
// The fixtures are not committed; without them these tests are skipped.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Runtime from "../runtime/index.ts";
import SdkDescriptor from "./index.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const chainDir = (sdk: string, chain: string) =>
  path.join(FIXTURES, `product-sdk-${sdk}`, "product-sdk", "packages", "descriptors", "chains", chain);
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("SdkDescriptor", { skip }, () => {
  // Loaded lazily: describe bodies run even when the suite is skipped.
  const load = (sdk: string) => SdkDescriptor.load(chainDir(sdk, "paseo-individuality"));

  it("reads the chain and the code hash the descriptors were generated from", () => {
    const old = load("0.24.0");
    assert.equal(old.chain, "paseo-individuality");
    assert.equal(old.codeHash, "0x3973b0f94d593b0018753766422f4898987115b5261ba368ccda84619a8bf582");
    assert.equal(load("0.42.0").codeHash, "0x69e7126f098bdf708302e52b892fd76c5d2477627bce47cbfcee7fcd5db17871");
  });

  it("lists every entry of every kind", () => {
    const count = (d: SdkDescriptor) => {
      const byKind: Record<string, number> = {};
      for (const e of d.entries()) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      return byKind;
    };
    assert.deepEqual(count(load("0.24.0")), { query: 272, tx: 295, event: 365, constant: 160, view: 31, api: 45 });
    assert.deepEqual(count(load("0.42.0")), { query: 291, tx: 356, event: 405, constant: 171, view: 57, api: 51 });
  });

  it("finds an entry by its selector", () => {
    const d = load("0.42.0");
    const account = d.entry("query:System.Account");
    assert.ok(account);
    assert.deepEqual(
      { kind: account.kind, group: account.group, name: account.name, direction: account.direction },
      { kind: "query", group: "System", name: "Account", direction: "both" },
    );
    assert.equal(d.entry("tx:Coinage.transfer")?.direction, "encode");
    assert.equal(d.entry("event:System.ExtrinsicSuccess")?.direction, "decode");
    assert.equal(d.entry("api:Core.version")?.kind, "api");
    assert.equal(d.entry("view:Assets.balance_of")?.kind, "view");
    assert.equal(d.entry("tx:NoSuchPallet.no_such_call"), undefined);
  });

  it("resolves the types behind an entry's shape", () => {
    const d = load("0.42.0");
    const { values } = d.entry("query:System.Account")?.shape ?? assert.fail("no System.Account");
    assert.equal(values.type, "lookup");
    if (values.type === "lookup") assert.equal(d.node(values.value).type, "struct"); // AccountInfo
  });

  it("tells the two SDK versions apart", () => {
    const old = load("0.24.0");
    const current = load("0.42.0");
    // Gone from the runtime since 0.24.0's descriptors were generated.
    assert.ok(old.entry("constant:Resources.MaxUsernameLength"));
    assert.equal(current.entry("constant:Resources.MaxUsernameLength"), undefined);
    // New since.
    assert.equal(old.entry("query:NetworkSuffix.NetworkSuffix"), undefined);
    assert.ok(current.entry("query:NetworkSuffix.NetworkSuffix"));
  });

  it("reads the extension pipelines: the person extensions moved from v0 to a new v1", () => {
    const old = load("0.24.0");
    const current = load("0.42.0");
    assert.deepEqual(Object.keys(old.pipelines), ["0"]);
    assert.ok(old.pipelines[0]?.includes("AsPerson"));
    assert.deepEqual(Object.keys(current.pipelines), ["0", "1"]);
    assert.ok(!current.pipelines[0]?.includes("AsPerson"));
    assert.ok(current.pipelines[1]?.includes("AsPerson"));
  });

  it("is the same metadata as the runtime it was generated from", () => {
    const wasm = fs.readFileSync(path.join(FIXTURES, "runtime-0.3.4", "next_people_paseo_runtime.compact.compressed.wasm"));
    const runtime = new Runtime(wasm);
    const d = load("0.42.0");
    assert.deepEqual(
      d.entries().map((e) => e.selector),
      runtime.entries().map((e) => e.selector),
    );
    assert.deepEqual(d.pipelines, runtime.pipelines);
  });
});

describe("SdkDescriptor.load", () => {
  const chainWith = (config: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-descriptor-"));
    fs.mkdirSync(path.join(dir, ".papi"));
    fs.writeFileSync(path.join(dir, ".papi", "polkadot-api.json"), JSON.stringify(config));
    return dir;
  };
  const entry = { metadata: "x.scale", codeHash: `0x${"ab".repeat(32)}` };

  it("refuses a config with more than one entry", () => {
    assert.throws(() => SdkDescriptor.load(chainWith({ entries: { a: entry, b: entry } })), /polkadot-api\.json/);
  });

  it("refuses an entry without a code hash", () => {
    assert.throws(() => SdkDescriptor.load(chainWith({ entries: { a: { metadata: "x.scale" } } })), /codeHash/);
  });
});
