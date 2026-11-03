import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { PipelineCheck, RuntimeCheck } from "../check/types.ts";
import SdkDescriptor from "../descriptor/index.ts";
import type { EntryChange, PipelineChange, RuntimeDiff } from "../diff/types.ts";
import type { Verdict } from "../regression/types.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import type { Level, Requirements, Selector, Use } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import buildReport, { assembleReport } from "./index.ts";
import toJson from "./json.ts";
import renderMarkdown from "./markdown.ts";
import type { EntryFinding, PipelineFinding, Report, Run } from "./types.ts";

// ── Hand-built findings ──────────────────────────────────

const use = (file: string, line: number, selector: Selector = "query:Game.Players"): Use => ({
  selector,
  chain: "individuality",
  optional: false,
  package: "@x/app",
  file,
  line,
});

const entry = (
  selector: Selector,
  verdict: Verdict,
  before: Level,
  after: Level,
  {
    uses = [use("app/src/a.ts", 1, selector)],
    change = null,
    optional = false,
    placedBy = "chain",
  }: { uses?: Use[]; change?: EntryChange | null; optional?: boolean; placedBy?: "chain" | "pallet" } = {},
): EntryFinding => ({
  requirement: { selector, direction: "both", expected: null, uses, placedBy, optional },
  before,
  after,
  verdict,
  change,
});

/** An entry change whose types were added at these paths, `u32` each. */
const changed = (selector: Selector, paths: string[], status: EntryChange["status"] = "changed"): EntryChange => ({
  selector,
  status,
  types: paths.map((path) => ({ path, status: "added", before: null, after: "u32" })),
  truncated: false,
});

const pipeline = (overrides: Partial<PipelineFinding>): PipelineFinding => ({
  version: 0,
  expected: ["A", "B", "C"],
  live: ["A", "B", "C"],
  candidate: ["A", "B", "C"],
  before: "Identical",
  after: "Identical",
  verdict: "ok",
  retypedFromSdk: [],
  change: null,
  ...overrides,
});

const pipelineChange = (overrides: Partial<PipelineChange>): PipelineChange => ({
  version: 0,
  status: "changed",
  live: ["A", "B", "C"],
  candidate: ["A", "B", "C"],
  added: [],
  removed: [],
  reordered: false,
  retyped: [],
  ...overrides,
});

const version = (specVersion: number) => ({ specName: "people", specVersion, transactionVersion: 1, codeHash: "0x" });

const report = (overrides: Partial<Report>): Report => ({
  chain: "individuality",
  descriptor: { chain: "paseo-individuality", codeHash: `0x${"ab".repeat(32)}` },
  live: version(1),
  candidate: version(2),
  entries: [],
  pipelines: [],
  extrinsicVersions: null,
  ...overrides,
});

const run = (...reports: Report[]): Run => ({ reports, unplaced: [], failed: [] });

describe("renderMarkdown", () => {
  it("leads with the number of breaking changes and counts every verdict per chain", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [
            entry("query:Game.Players", "breaking", "Identical", "Missing"),
            entry("query:Game.Rounds", "ok", "Identical", "Identical"),
            entry("constants:Score.Suffix", "pre-existing", "Missing", "Missing"),
          ],
          pipelines: [pipeline({})],
        }),
        report({ chain: "assetHub", entries: [entry("query:System.Number", "ok", "Identical", "Identical")] }),
      ),
    );
    const lines = markdown.split("\n");
    assert.equal(lines[0], "### 🔴 Metadata check: 1 breaking change for the product-sdk");
    assert.ok(lines.includes("| People | 1 → 2 | 1 | 1 | 2 |"));
    assert.ok(lines.includes("| Asset Hub | 1 → 2 | 0 | 0 | 1 |"));
    assert.ok(lines.includes("#### People: 1 breaking"));
    // A chain with nothing to show gets no section.
    assert.ok(!lines.some((line) => line.startsWith("#### Asset Hub")));
  });

  it("says so when nothing breaks", async () => {
    const markdown = renderMarkdown(run(report({ entries: [entry("query:Game.Players", "ok", "Identical", "Identical")] })));
    assert.ok(markdown.startsWith("### 🟢 Metadata check: no breaking change for the product-sdk\n"));
    assert.ok(!markdown.includes("####"));
  });

  it("shows where an entry changed, where it is read, and its markers", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [
            entry("tx:Sudo.sudo", "breaking", "Identical", "Partial", {
              change: changed("tx:Sudo.sudo", ["args.call"]),
              placedBy: "pallet",
              uses: [use("a.ts", 1), use("a.ts", 9), use("b.ts", 3)],
            }),
            entry("query:Game.Seats", "breaking", "Identical", "Incompatible", { optional: true }),
          ],
        }),
      ),
    );
    assert.ok(markdown.includes("| `tx:Sudo.sudo` † | Identical → **Partial** at `args.call` | `a.ts:1`, `:9`, `b.ts:3` |"));
    assert.ok(markdown.includes("| `query:Game.Seats` ? | Identical → **Incompatible** | `app/src/a.ts:1` |"));
  });

  it("names the path an entry's changes share and counts them, or each side they are on", async () => {
    const cell = (change: EntryChange) =>
      renderMarkdown(run(report({ entries: [entry(change.selector, "breaking", "Identical", "Partial", { change })] })))
        .split("\n")
        .find((line) => line.startsWith(`| \`${change.selector}\``));
    assert.match(cell(changed("tx:Sudo.sudo", ["args.call.A.x", "args.call.B"])) ?? "", /\*\*Partial\*\* at `args.call` \(2 changes\) \|/);
    assert.match(cell(changed("apis:A.b", ["args.0", "value.ok"])) ?? "", /\*\*Partial\*\* at `args`, `value` \(2 changes\) \|/);
    assert.match(cell({ ...changed("apis:A.b", ["value.ok"]), truncated: true }) ?? "", / at `value.ok` \(1\+ changes\) \|/);
    // An added or removed entry: its level already says it.
    assert.match(cell(changed("query:A.b", ["value"], "removed")) ?? "", /\*\*Partial\*\* \|/);
  });

  it("caps the places an entry is read at", async () => {
    const uses = Array.from({ length: 9 }, (_, i) => use(`f${i}.ts`, i));
    const markdown = renderMarkdown(run(report({ entries: [entry("query:Game.Players", "breaking", "Identical", "Missing", { uses })] })));
    assert.ok(markdown.includes("`f5.ts:5`, +3 more |"));
  });

  it("collapses the pre-existing findings", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [entry("constants:Score.Suffix", "pre-existing", "Missing", "Missing")],
          pipelines: [pipeline({ verdict: "pre-existing", before: "Incompatible", after: "Incompatible" })],
        }),
      ),
    );
    assert.ok(markdown.includes("#### People\n"));
    assert.ok(markdown.includes("<details><summary>🟡 Pre-existing (2): broken on live already, not caused by this upgrade</summary>"));
    assert.ok(markdown.includes("| `constants:Score.Suffix` | Missing → Missing | `app/src/a.ts:1` |"));
    assert.ok(markdown.includes("| transaction extensions v0 | Incompatible → Incompatible | — |"));
  });

  it("summarises a breaking pipeline against what the SDK signs with", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          pipelines: [
            pipeline({
              candidate: ["C", "A", "D"],
              after: "Incompatible",
              verdict: "breaking",
            }),
          ],
        }),
      ),
    );
    assert.ok(markdown.includes("**Transaction extensions v0: breaking** (Identical → Incompatible)  "));
    assert.ok(markdown.includes("Candidate lacks what the SDK signs with: `B`  "));
    assert.ok(markdown.includes("Candidate adds: `D`  "));
    assert.ok(markdown.includes("Candidate reorders the extensions the SDK signs with.  "));
    assert.ok(markdown.includes("| 2 | ~~B~~ | B | A |"));
    assert.ok(markdown.includes("| 3 | C | C | **D** |"));
  });

  it("lists what changed between live and candidate, whatever its verdict, collapsed", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [
            entry("query:Game.Players", "ok", "Identical", "Identical", { change: changed("query:Game.Players", ["value.a", "value.b"]) }),
            entry("constants:Game.Gone", "breaking", "Identical", "Missing", {
              change: {
                selector: "constants:Game.Gone",
                status: "removed",
                types: [{ path: "value", status: "removed", before: "enum { A, B }", after: null }],
                truncated: false,
              },
            }),
            entry("query:Game.Same", "ok", "Identical", "Identical"),
          ],
          pipelines: [
            pipeline({
              verdict: "breaking",
              change: pipelineChange({
                removed: ["B"],
                added: ["D"],
                reordered: true,
                retyped: [
                  {
                    identifier: "C",
                    types: [{ path: "type", status: "changed", before: "u32", after: "Option<u32>" }],
                    truncated: false,
                  },
                ],
              }),
            }),
            pipeline({ version: 1, change: pipelineChange({ version: 1, status: "added", live: null, added: ["A", "B"] }) }),
          ],
        }),
      ),
    );
    const section = markdown.slice(markdown.indexOf("<details><summary>What changed"));
    assert.deepEqual(section.slice(0, section.indexOf("</details>")).split("\n"), [
      "<details><summary>What changed between live and candidate (2 entries, 2 extension versions)</summary>",
      "",
      "- 🔴 Transaction extensions v0: removes `B`; adds `D`; reorders the rest; retypes `C`",
      "- 🟢 Transaction extensions v1: new, with `A`, `B`",
      "",
      "| Entry / extension | Where | Live | Candidate |",
      "|---|---|---|---|",
      "| 🟢 `query:Game.Players` | `value.a` | — | `u32` |",
      "|  | `value.b` | — | `u32` |",
      "| 🔴 `constants:Game.Gone` (removed) | `value` | `enum { A, B }` | — |",
      // The extension's row has its version's verdict: it has none of its own.
      "| 🔴 v0 `C` | `type` | `u32` | `Option<u32>` |",
      "",
    ]);
  });

  it("gives an added or removed entry with nothing to encode a row of its own", async () => {
    const gone: EntryChange = { selector: "tx:Game.offboard", status: "removed", types: [], truncated: false };
    const markdown = renderMarkdown(run(report({ entries: [entry("tx:Game.offboard", "breaking", "Identical", "Missing", { change: gone })] })));
    assert.ok(markdown.includes("| 🔴 `tx:Game.offboard` (removed) | — | `()` | — |"));
    assert.ok(markdown.includes("<details><summary>What changed between live and candidate (1 entry)</summary>"));
  });

  it("says when an extension version that comes or goes has no extensions", async () => {
    const markdown = renderMarkdown(
      run(
        report({
          pipelines: [
            pipeline({ version: 2, change: pipelineChange({ version: 2, status: "added", live: null, candidate: [] }) }),
            pipeline({ version: 3, change: pipelineChange({ version: 3, status: "removed", live: [], candidate: null }) }),
          ],
        }),
      ),
    );
    assert.ok(markdown.includes("- 🟢 Transaction extensions v2: new, with no extensions\n"));
    assert.ok(markdown.includes("- 🟢 Transaction extensions v3: gone; live had no extensions\n"));
  });

  it("lists the extrinsic versions the candidate stops or starts accepting, ungraded", async () => {
    const markdown = renderMarkdown(
      run(report({ extrinsicVersions: { live: [4, 5], candidate: [5, 6], added: [6], removed: [4] } })),
    );
    assert.ok(markdown.includes("<details><summary>What changed between live and candidate (extrinsic versions)</summary>"));
    assert.ok(markdown.includes("- ⚪ Extrinsic versions: removes `4`; adds `6` (not graded)\n"));
  });

  it("says under the headline when a candidate stops accepting an extrinsic version, without grading it", () => {
    const markdown = renderMarkdown(run(report({ extrinsicVersions: { live: [4, 5], candidate: [5], added: [], removed: [4] } })));
    assert.deepEqual(markdown.split("\n").slice(0, 4), [
      "### 🟢 Metadata check: no breaking change for the product-sdk",
      "",
      "> ⚪ People: the candidate stops accepting extrinsic version `4` (not graded)",
      "",
    ]);
    const adds = renderMarkdown(run(report({ extrinsicVersions: { live: [4], candidate: [4, 5], added: [5], removed: [] } })));
    assert.ok(!adds.includes("> ⚪"));
  });

  it("says how often each list has an extension one lists twice, rather than that it moved", () => {
    const lists = { expected: ["A", "A", "B"], live: ["A", "A", "B"], candidate: ["A", "B"] };
    const markdown = renderMarkdown(
      run(
        report({
          pipelines: [
            pipeline({ ...lists, verdict: "breaking", after: "Incompatible", change: pipelineChange({ ...lists, removed: ["A"] }) }),
          ],
        }),
      ),
    );
    assert.ok(markdown.includes("<details><summary>What changed between live and candidate (1 extension version)</summary>"));
    assert.ok(markdown.includes("- 🔴 Transaction extensions v0: removes `A` (2 → 1)\n"));
    assert.ok(markdown.includes("Candidate lacks what the SDK signs with: `A` (2 → 1)  "));
    assert.ok(!markdown.includes("reorders"));
  });

  it("caps the changes it lists per entry, and keeps a table cell whole", async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `value.f${i}`);
    const change = { ...changed("query:Game.Players", paths), truncated: true };
    change.types[0] = { path: "value.f0", status: "changed", before: "A | B", after: "u32" };
    const markdown = renderMarkdown(run(report({ entries: [entry("query:Game.Players", "ok", "Identical", "Identical", { change })] })));
    assert.ok(markdown.includes("| 🟢 `query:Game.Players` | `value.f0` | `A \\| B` | `u32` |"));
    assert.ok(markdown.includes("|  | `value.f4` | — | `u32` |\n| | … 2 more in report.json, and more past its limit | | |"));
    // Nothing breaking or pre-existing, and still a section: the upgrade changed something.
    assert.ok(markdown.includes("#### People\n"));
  });

  it("says when the candidate has no such pipeline", async () => {
    const markdown = renderMarkdown(
      run(report({ pipelines: [pipeline({ candidate: null, after: "Missing", verdict: "breaking" })] })),
    );
    assert.ok(markdown.includes("The candidate has no v0."));
  });

  it("says when no runtime was upgraded", () => {
    assert.equal(renderMarkdown({ reports: [], unplaced: [], failed: [] }), "### ⚪ Metadata check: no runtime upgraded in this run");
  });

  it("names the chains it could not check, under the headline", () => {
    const markdown = renderMarkdown({ reports: [report({})], unplaced: [], failed: [{ chain: "people", error: "no live runtime" }] });
    assert.deepEqual(markdown.split("\n").slice(0, 4), [
      "### 🟢 Metadata check: no breaking change for the product-sdk",
      "",
      "> ⚠️ `people` was not checked: no live runtime",
      "",
    ]);
  });

  it("lists the reads on chains the run does not check", async () => {
    const markdown = renderMarkdown({
      reports: [report({})],
      unplaced: [use("cloud-storage/src/verify.ts", 100, "query:TransactionStorage.Transactions")],
      failed: [],
    });
    assert.ok(markdown.includes("<details><summary>Reads on a chain this run does not check (1)</summary>"));
    assert.ok(markdown.includes("- `query:TransactionStorage.Transactions` at `cloud-storage/src/verify.ts:100`"));
  });
});

describe("toJson", () => {
  it("writes a stable shape, without the internal objects", async () => {
    const json = toJson({
      reports: [
        report({
          entries: [
            entry("tx:Sudo.sudo", "breaking", "Identical", "Partial", {
              change: changed("tx:Sudo.sudo", ["args.call"]),
              uses: [use("a.ts", 7)],
            }),
          ],
          pipelines: [
            pipeline({
              retypedFromSdk: ["B"],
              change: pipelineChange({
                removed: ["C"],
                retyped: [{ identifier: "B", types: [{ path: "type", status: "changed", before: "u32", after: "u64" }], truncated: false }],
              }),
            }),
          ],
        }),
      ],
      unplaced: [],
      failed: [],
    });
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.chains[0]?.extrinsicVersions, null);
    // Its own shape, not the internal object: a field added inside does not reach the artifact.
    const versions = { live: [4, 5], candidate: [5], added: [], removed: [4], internal: true };
    const withVersions = toJson(run(report({ extrinsicVersions: versions })));
    assert.deepEqual(withVersions.chains[0]?.extrinsicVersions, { live: [4, 5], candidate: [5], added: [], removed: [4] });
    assert.deepEqual(json.chains[0]?.entries, [
      {
        selector: "tx:Sudo.sudo",
        verdict: "breaking",
        before: "Identical",
        after: "Partial",
        change: {
          status: "changed",
          types: [{ path: "args.call", status: "added", before: null, after: "u32" }],
          truncated: false,
        },
        direction: "both",
        optional: false,
        placedBy: "chain",
        uses: [{ package: "@x/app", file: "a.ts", line: 7 }],
      },
    ]);
    assert.deepEqual(json.chains[0]?.pipelines[0]?.retypedFromSdk, ["B"]);
    // The lists themselves are the pipeline's live and candidate.
    assert.deepEqual(json.chains[0]?.pipelines[0]?.change, {
      status: "changed",
      added: [],
      removed: ["C"],
      reordered: false,
      retyped: [{ identifier: "B", types: [{ path: "type", status: "changed", before: "u32", after: "u64" }], truncated: false }],
    });
    // Plain data: survives a round trip.
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});

describe("assembleReport", () => {
  const players = entry("query:Game.Players", "ok", "Identical", "Identical").requirement;
  const sudo = entry("tx:Sudo.sudo", "ok", "Identical", "Identical").requirement;
  const checked = (specVersion: number, levels: [Level, Level], pipelines: PipelineCheck[]): RuntimeCheck => ({
    chain: "individuality",
    descriptor: { chain: "paseo-individuality", codeHash: "0x00" },
    runtime: version(specVersion),
    entries: [
      { requirement: players, level: levels[0] },
      { requirement: sudo, level: levels[1] },
    ],
    pipelines,
  });

  const added = pipelineChange({ version: 1, status: "added", live: null, candidate: ["A", "B"], added: ["A", "B"] });

  it("joins both checks, their verdicts and the diff into one chain's report", () => {
    const r = assembleReport(
      checked(1, ["Identical", "Identical"], [{ version: 0, expected: ["A"], actual: ["A"], level: "Identical", retyped: [] }]),
      checked(
        2,
        ["Identical", "Partial"],
        [
          { version: 0, expected: ["A"], actual: ["A"], level: "BackwardsCompatible", retyped: ["A"] },
          { version: 1, expected: null, actual: ["A", "B"], level: "Present", retyped: [] },
        ],
      ),
      {
        chain: "individuality",
        entries: [changed("tx:Sudo.sudo", ["args.call"])],
        pipelines: [added],
        extrinsicVersions: { live: [4, 5], candidate: [5], added: [], removed: [4] },
      },
    );
    assert.deepEqual(r.extrinsicVersions?.removed, [4]);
    assert.deepEqual([r.live.specVersion, r.candidate.specVersion], [1, 2]);
    assert.deepEqual(
      r.entries.map((e) => `${e.requirement.selector} ${e.before}->${e.after} ${e.verdict} [${(e.change?.types ?? []).map((t) => t.path).join()}]`),
      ["query:Game.Players Identical->Identical ok []", "tx:Sudo.sudo Identical->Partial breaking [args.call]"],
    );
    // Lists from each side, D's from either, what the candidate retyped, and what changed.
    assert.deepEqual(r.pipelines, [
      pipeline({ after: "BackwardsCompatible", expected: ["A"], live: ["A"], candidate: ["A"], retypedFromSdk: ["A"] }),
      pipeline({ version: 1, before: "Missing", after: "Present", expected: null, live: null, candidate: ["A", "B"], change: added }),
    ]);
  });

  it("refuses a diff of other requirements or another chain: its changes would vanish", () => {
    const live = checked(1, ["Identical", "Identical"], []);
    const assemble = (changes: RuntimeDiff) => () => assembleReport(live, checked(2, ["Identical", "Identical"], []), changes);
    const refused = /the diff is not of the requirements and chain the checks are/;
    const none = { entries: [], pipelines: [], extrinsicVersions: null };
    assert.throws(assemble({ ...none, chain: "assetHub" }), refused);
    assert.throws(assemble({ ...none, chain: "individuality", entries: [changed("query:Game.Rounds", ["value"])] }), refused);
    assert.throws(assemble({ ...none, chain: "individuality", pipelines: [added] }), refused);
  });
});

// ── On the fixtures (see fixtures/README.md); skipped without them ──

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("buildReport on the fixtures", { skip }, () => {
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

  /** One chain's requirements for an SDK version. */
  const requirementsOf = async (sdk: string, chain: Chain, usage: SdkUsage): Promise<Requirements> => {
    const descriptor = await SdkDescriptor.load(path.join(packagesOf(sdk), "descriptors", "chains", DESCRIPTOR[chain]));
    const [requirements] = buildRequirements({ [chain]: descriptor }, usage).chains;
    assert.ok(requirements);
    return requirements;
  };

  /** One chain's report for an SDK version and an upgrade, by default People from v0.3.1 to v0.3.4. */
  const fixtureReport = async (
    sdk: string,
    { live = "0.3.1", candidate = "0.3.4", chain = "individuality" as Chain, usage = SdkUsage.scan(packagesOf(sdk)) } = {},
  ): Promise<Report> => buildReport(await requirementsOf(sdk, chain, usage), runtime(live, chain), runtime(candidate, chain));
  const notOk = (r: Report) =>
    r.entries.filter((e) => e.verdict !== "ok").map((e) => `${e.verdict} ${e.requirement.selector} ${e.before}->${e.after}`);
  const breaking = (r: Report) => [
    ...r.entries
      .filter((e) => e.verdict === "breaking")
      .map((e) => {
        const at = e.change?.status === "changed" ? e.change.types.map((t) => t.path.split(".").slice(0, 2).join(".")) : [];
        return `${e.requirement.selector} ${e.before}->${e.after} ${[...new Set(at)].join(",")}`.trim();
      }),
    ...r.pipelines.filter((p) => p.verdict === "breaking").map((p) => `pipeline v${p.version} ${p.before}->${p.after}`),
  ];
  const pipelines = (r: Report) => r.pipelines.map((p) => `v${p.version} ${p.verdict} ${p.before}->${p.after}`);

  it("finds nothing breaking for the SDK generated from the candidate", async () => {
    const r = await fixtureReport("0.42.0");
    assert.deepEqual(pipelines(r), ["v0 ok Incompatible->Identical", "v1 ok Missing->Identical"]);
    // Read by the SDK as a fallback for older runtimes; neither runtime has it.
    assert.deepEqual(notOk(r), ["pre-existing constants:Score.Suffix Missing->Missing"]);
  });

  // Demo 1, the gate's case: the next runtime drops a constant the current SDK reads.
  it("breaks the current SDK on the nightly: a constant it reads is gone (Rule 1)", async () => {
    const r = await fixtureReport("0.42.0", { live: "0.3.4", candidate: "nightly-3004007" });
    assert.deepEqual(breaking(r), ["constants:Game.airdrop_event_id_base Identical->Missing"]);
    const gone = r.entries.find((e) => e.requirement.selector === "constants:Game.airdrop_event_id_base");
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
    const r = await fixtureReport("0.28.0");
    assert.deepEqual(breaking(r), ["tx:Sudo.sudo Identical->Partial args.call", "pipeline v0 Identical->Incompatible"]);
    // v1 only exists on the candidate: the old SDK never signs with it.
    assert.deepEqual(pipelines(r), ["v0 breaking Identical->Incompatible", "v1 ok Missing->Present"]);
  });

  it("breaks SDK 0.28.0 on Asset Hub: a runtime API result that no longer always decodes", async () => {
    assert.deepEqual(breaking(await fixtureReport("0.28.0", { chain: "assetHub" })), [
      "apis:ReviveApi.call Identical->Partial value.result",
      "tx:Sudo.sudo Identical->Partial args.call",
      "pipeline v0 Identical->Incompatible",
    ]);
  });

  it("names the runtimes and D in the report", async () => {
    const r = await fixtureReport("0.42.0");
    assert.equal(r.chain, "individuality");
    assert.deepEqual([r.live.specVersion, r.candidate.specVersion], [3001000, 3004000]);
    assert.equal(r.descriptor.codeHash, r.candidate.codeHash);
  });

  it("finds nothing breaking when live and candidate are the same runtime", async () => {
    const r = await fixtureReport("0.28.0", { live: "0.3.4", candidate: "0.3.4" });
    assert.ok([...r.entries, ...r.pipelines].every((finding) => finding.verdict !== "breaking"));
  });
});

describe("renderMarkdown on demo 1", { skip }, () => {
  it("renders the current SDK breaking on the nightly", async () => {
    const packages = path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages");
    const descriptor = await SdkDescriptor.load(path.join(packages, "descriptors", "chains", "paseo-individuality"));
    const set = buildRequirements({ individuality: descriptor }, SdkUsage.scan(packages));
    const wasm = (release: string) =>
      new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, "next_people_paseo_runtime.compact.compressed.wasm")));
    const [requirements] = set.chains;
    assert.ok(requirements);
    const markdown = renderMarkdown({
      reports: [buildReport(requirements, wasm("0.3.4"), wasm("nightly-3004007"))],
      unplaced: [],
      failed: [],
    });
    assert.equal(
      markdown,
      [
        "### 🔴 Metadata check: 1 breaking change for the product-sdk",
        "",
        "| Chain | Runtime (live → candidate) | 🔴 Breaking | 🟡 Pre-existing | 🟢 OK |",
        "|---|---|---|---|---|",
        "| People | 3004000 → 3004007 | 1 | 1 | 53 |",
        "",
        "#### People: 1 breaking",
        "",
        "| Entry | Live → candidate | Read at |",
        "|---|---|---|",
        "| `constants:Game.airdrop_event_id_base` | Identical → **Missing** | `individuality/src/airdrop-read.ts:292`, `:318`, `individuality/src/prize-status.ts:132`, `individuality/src/signup.ts:290` |",
        "",
        "<details><summary>🟡 Pre-existing (1): broken on live already, not caused by this upgrade</summary>",
        "",
        "| Entry | Live → candidate | Read at |",
        "|---|---|---|",
        "| `constants:Score.Suffix` | Missing → Missing | `individuality/src/rings.ts:297` |",
        "</details>",
        "",
        "<details><summary>What changed between live and candidate (3 entries)</summary>",
        "",
        "| Entry / extension | Where | Live | Candidate |",
        "|---|---|---|---|",
        "| 🔴 `constants:Game.airdrop_event_id_base` (removed) | `value` | `[u8; 27]` | — |",
        "| 🟢 `query:Score.Participants` | `value.attended_games_while_recognized` | — | `u32` |",
        "| 🟢 `tx:Sudo.sudo` | `args.call.Parameters.set_parameter.key_value.LitePersonhood.PaidRegistrationThreshold` | — | `[Option<u32>; 1]` |",
        "|  | `args.call.Parameters.set_parameter.key_value.LitePersonhood.PaidRegistrationPeriod` | — | `[Option<u32>; 1]` |",
        "|  | `args.call.Parameters.set_parameter.key_value.LitePersonhood.PaidRegistrationsPerPeriod` | — | `[Option<u32>; 1]` |",
        "|  | `args.call.Parameters.set_parameter.key_value.LitePersonhood.MaxLitePeople` | — | `[Option<u32>; 1]` |",
        "</details>",
        "",
        "<sub>D: `paseo-individuality` from `0x69e7…7871` · `?` optional read · `†` chain inferred from the pallet</sub>",
      ].join("\n"),
    );
  });
});
