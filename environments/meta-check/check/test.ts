import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import SdkDescriptor from "../descriptor/index.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import type { Level, Report } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import check from "./index.ts";
import { verdict } from "./grade.ts";

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

// Against fixtures/ (see fixtures/README.md): A = v0.3.1, A' = v0.3.4. Skipped without them.
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("check on the fixtures", { skip }, () => {
  type Chain = "individuality" | "assetHub";
  const WASM: Record<Chain, string> = {
    individuality: "next_people_paseo_runtime.compact.compressed.wasm",
    assetHub: "next_asset_hub_paseo_runtime.compact.compressed.wasm",
  };
  const DESCRIPTOR: Record<Chain, string> = { individuality: "paseo-individuality", assetHub: "paseo-asset-hub" };
  const packagesOf = (sdk: string) => path.join(FIXTURES, `product-sdk-${sdk}`, "product-sdk", "packages");

  // Loading a runtime runs its wasm; do each once.
  const runtimes = new Map<string, Runtime>();
  const runtime = (release: string, chain: Chain): Runtime => {
    const key = `${release} ${chain}`;
    const known = runtimes.get(key);
    if (known) return known;
    const loaded = new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, WASM[chain])));
    runtimes.set(key, loaded);
    return loaded;
  };

  /** One chain's report for an SDK version and an upgrade, by default People from v0.3.1 to v0.3.4. */
  const report = async (
    sdk: string,
    { live = "0.3.1", candidate = "0.3.4", chain = "individuality" as Chain, usage = SdkUsage.scan(packagesOf(sdk)) } = {},
  ): Promise<Report> => {
    const descriptor = await SdkDescriptor.load(path.join(packagesOf(sdk), "descriptors", "chains", DESCRIPTOR[chain]));
    const [requirements] = buildRequirements({ [chain]: descriptor }, usage).chains;
    assert.ok(requirements);
    return check(requirements, runtime(live, chain), runtime(candidate, chain));
  };
  const notOk = (r: Report) =>
    r.entries.filter((e) => e.verdict !== "ok").map((e) => `${e.verdict} ${e.requirement.selector} ${e.before}->${e.after}`);
  const breaking = (r: Report) => [
    ...r.entries
      .filter((e) => e.verdict === "breaking")
      .map((e) => `${e.requirement.selector} ${e.before}->${e.after} ${e.changedAt.join(",")}`.trim()),
    ...r.pipelines.filter((p) => p.verdict === "breaking").map((p) => `pipeline v${p.version} ${p.before}->${p.after}`),
  ];
  const pipelines = (r: Report) => r.pipelines.map((p) => `v${p.version} ${p.verdict} ${p.before}->${p.after}`);

  it("finds nothing breaking for the SDK generated from the candidate", async () => {
    const r = await report("0.42.0");
    assert.deepEqual(pipelines(r), ["v0 ok Incompatible->Identical", "v1 ok Missing->Identical"]);
    // Read by the SDK as a fallback for older runtimes; neither runtime has it.
    assert.deepEqual(notOk(r), ["pre-existing constant:Score.Suffix Missing->Missing"]);
  });

  // Demo 1, the gate's case: the next runtime drops a constant the current SDK reads.
  it("breaks the current SDK on the nightly: a constant it reads is gone (Rule 1)", async () => {
    const r = await report("0.42.0", { live: "0.3.4", candidate: "nightly-3004007" });
    assert.deepEqual(breaking(r), ["constant:Game.airdrop_event_id_base Identical->Missing"]);
    const gone = r.entries.find((e) => e.requirement.selector === "constant:Game.airdrop_event_id_base");
    assert.deepEqual(
      gone?.requirement.uses.map((u) => `${u.file}:${u.line}`),
      [
        "individuality/src/airdrop-read.ts:292",
        "individuality/src/airdrop-read.ts:318",
        "individuality/src/prize-status.ts:132",
        "individuality/src/signup.ts:290",
      ],
    );
  });

  // Demo 2: an SDK whose descriptors still match v0.3.1.
  it("breaks SDK 0.28.0 on People: a new Partial (Rule 2) and the extension move (Rule 3)", async () => {
    const r = await report("0.28.0");
    assert.deepEqual(breaking(r), ["tx:Sudo.sudo Identical->Partial args.call", "pipeline v0 Identical->Incompatible"]);
    // v1 only exists on the candidate: the old SDK never signs with it.
    assert.deepEqual(pipelines(r), ["v0 breaking Identical->Incompatible", "v1 ok Missing->Present"]);
  });

  it("breaks SDK 0.28.0 on Asset Hub: a runtime API result that no longer always decodes", async () => {
    assert.deepEqual(breaking(await report("0.28.0", { chain: "assetHub" })), [
      "api:ReviveApi.call Identical->Partial value.result",
      "tx:Sudo.sudo Identical->Partial args.call",
      "pipeline v0 Identical->Incompatible",
    ]);
  });

  it("names the runtimes and D in the report", async () => {
    const r = await report("0.42.0");
    assert.equal(r.chain, "individuality");
    assert.deepEqual([r.live.specVersion, r.candidate.specVersion], [3001000, 3004000]);
    assert.equal(r.descriptor.codeHash, r.candidate.codeHash);
  });

  it("finds nothing breaking when live and candidate are the same runtime", async () => {
    const r = await report("0.28.0", { live: "0.3.4", candidate: "0.3.4" });
    assert.ok([...r.entries, ...r.pipelines].every((finding) => finding.verdict !== "breaking"));
  });

  it("skips the pipelines on a chain the SDK does not sign on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@x/reader" }));
    fs.writeFileSync(path.join(dir, "src", "read.ts"), "chain.individuality.query.Game.Players;");
    const r = await report("0.42.0", { usage: SdkUsage.scan(dir) });
    assert.deepEqual(r.pipelines, []);
    assert.deepEqual(
      r.entries.map((e) => `${e.requirement.selector} ${e.verdict}`),
      ["query:Game.Players ok"],
    );
  });
});
