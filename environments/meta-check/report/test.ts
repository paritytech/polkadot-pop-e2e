import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import check from "../check/index.ts";
import SdkDescriptor from "../descriptor/index.ts";
import buildRequirements from "../requirements/index.ts";
import Runtime from "../runtime/index.ts";
import type { EntryFinding, Level, PipelineFinding, Report, Run, Selector, Use, Verdict } from "../types.ts";
import SdkUsage from "../usage/index.ts";
import toJson from "./json.ts";
import renderMarkdown from "./markdown.ts";

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
    changedAt = [],
    optional = false,
    placedBy = "chain",
  }: { uses?: Use[]; changedAt?: string[]; optional?: boolean; placedBy?: "chain" | "pallet" } = {},
): EntryFinding => ({
  requirement: { selector, direction: "both", expected: null, uses, placedBy, optional },
  before,
  after,
  verdict,
  changedAt,
});

const pipeline = (overrides: Partial<PipelineFinding>): PipelineFinding => ({
  version: 0,
  expected: ["A", "B", "C"],
  live: ["A", "B", "C"],
  candidate: ["A", "B", "C"],
  before: "Identical",
  after: "Identical",
  verdict: "ok",
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
  ...overrides,
});

const run = (...reports: Report[]): Run => ({ reports, unplaced: [] });

describe("renderMarkdown", () => {
  it("leads with the number of breaking changes and counts every verdict per chain", () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [
            entry("query:Game.Players", "breaking", "Identical", "Missing"),
            entry("query:Game.Rounds", "ok", "Identical", "Identical"),
            entry("constant:Score.Suffix", "pre-existing", "Missing", "Missing"),
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

  it("says so when nothing breaks", () => {
    const markdown = renderMarkdown(run(report({ entries: [entry("query:Game.Players", "ok", "Identical", "Identical")] })));
    assert.ok(markdown.startsWith("### 🟢 Metadata check: no breaking change for the product-sdk\n"));
    assert.ok(!markdown.includes("####"));
  });

  it("shows where an entry changed, where it is read, and its markers", () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [
            entry("tx:Sudo.sudo", "breaking", "Identical", "Partial", {
              changedAt: ["args.call"],
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

  it("caps the places an entry is read at", () => {
    const uses = Array.from({ length: 9 }, (_, i) => use(`f${i}.ts`, i));
    const markdown = renderMarkdown(run(report({ entries: [entry("query:Game.Players", "breaking", "Identical", "Missing", { uses })] })));
    assert.ok(markdown.includes("`f5.ts:5`, +3 more |"));
  });

  it("collapses the pre-existing findings", () => {
    const markdown = renderMarkdown(
      run(
        report({
          entries: [entry("constant:Score.Suffix", "pre-existing", "Missing", "Missing")],
          pipelines: [pipeline({ verdict: "pre-existing", before: "Incompatible", after: "Incompatible" })],
        }),
      ),
    );
    assert.ok(markdown.includes("#### People\n"));
    assert.ok(markdown.includes("<details><summary>🟡 Pre-existing (2): broken on live already, not caused by this upgrade</summary>"));
    assert.ok(markdown.includes("| `constant:Score.Suffix` | Missing → Missing | `app/src/a.ts:1` |"));
    assert.ok(markdown.includes("| transaction extensions v0 | Incompatible → Incompatible | — |"));
  });

  it("summarises a breaking pipeline against what the SDK signs with", () => {
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

  it("says when the candidate has no such pipeline", () => {
    const markdown = renderMarkdown(
      run(report({ pipelines: [pipeline({ candidate: null, after: "Missing", verdict: "breaking" })] })),
    );
    assert.ok(markdown.includes("The candidate has no v0."));
  });

  it("lists the reads on chains the run does not check", () => {
    const markdown = renderMarkdown({
      reports: [report({})],
      unplaced: [use("cloud-storage/src/verify.ts", 100, "query:TransactionStorage.Transactions")],
    });
    assert.ok(markdown.includes("<details><summary>Reads on a chain this run does not check (1)</summary>"));
    assert.ok(markdown.includes("- `query:TransactionStorage.Transactions` at `cloud-storage/src/verify.ts:100`"));
  });
});

describe("toJson", () => {
  it("writes a stable shape, without the internal objects", () => {
    const json = toJson({
      reports: [
        report({
          entries: [entry("tx:Sudo.sudo", "breaking", "Identical", "Partial", { changedAt: ["args.call"], uses: [use("a.ts", 7)] })],
          pipelines: [pipeline({ retyped: ["B"] })],
        }),
      ],
      unplaced: [],
    });
    assert.equal(json.schemaVersion, 1);
    assert.deepEqual(json.chains[0]?.entries, [
      {
        selector: "tx:Sudo.sudo",
        verdict: "breaking",
        before: "Identical",
        after: "Partial",
        changedAt: ["args.call"],
        direction: "both",
        optional: false,
        placedBy: "chain",
        uses: [{ package: "@x/app", file: "a.ts", line: 7 }],
      },
    ]);
    assert.deepEqual(json.chains[0]?.pipelines[0]?.retyped, ["B"]);
    // Plain data: survives a round trip.
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});

// ── Demo 1 on the fixtures (see fixtures/README.md); skipped without them ──

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const skip = fs.existsSync(FIXTURES) ? false : "fixtures/ not downloaded";

describe("renderMarkdown on demo 1", { skip }, () => {
  it("renders the current SDK breaking on the nightly", () => {
    const packages = path.join(FIXTURES, "product-sdk-0.42.0", "product-sdk", "packages");
    const descriptor = SdkDescriptor.load(path.join(packages, "descriptors", "chains", "paseo-individuality"));
    const set = buildRequirements({ individuality: descriptor }, SdkUsage.scan(packages));
    const wasm = (release: string) =>
      new Runtime(fs.readFileSync(path.join(FIXTURES, `runtime-${release}`, "next_people_paseo_runtime.compact.compressed.wasm")));
    const [requirements] = set.chains;
    assert.ok(requirements);
    const markdown = renderMarkdown({
      reports: [check(requirements, wasm("0.3.4"), wasm("nightly-3004007"))],
      unplaced: [],
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
        "| `constant:Game.airdrop_event_id_base` | Identical → **Missing** | `individuality/src/airdrop-read.ts:292`, `:318`, `individuality/src/prize-status.ts:132`, `individuality/src/signup.ts:290` |",
        "",
        "<details><summary>🟡 Pre-existing (1): broken on live already, not caused by this upgrade</summary>",
        "",
        "| Entry | Live → candidate | Read at |",
        "|---|---|---|",
        "| `constant:Score.Suffix` | Missing → Missing | `individuality/src/rings.ts:297` |",
        "</details>",
        "",
        "<sub>D: `paseo-individuality` from `0x69e7…7871` · `?` optional read · `†` chain inferred from the pallet</sub>",
      ].join("\n"),
    );
  });
});
