// The report on a gate run, and the test results it reads. No chain is needed: the
// diff is a fixture, and the test scripts run against a stand-in pnpm.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ChainDiff, Diff } from "./diff.ts";
import { readJson } from "./json.ts";
import { failuresFromJunit, readFailures, type Failure } from "./junit.ts";
import { explainFailures, linksFor } from "./links.ts";
import { issueUrl, renderReport } from "./markdown.ts";

const HERE = import.meta.dirname;
const TESTS_DIR = path.join(HERE, "..", "..", "packages", "chain-tests");
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="2">
  <testsuite name="src/tests/lite-alias-bind.test.ts">
    <testcase classname="src/tests/lite-alias-bind.test.ts" name="Lite sign-up &gt; binds the alias" time="1">
      <failure message="Incompatible runtime entry Tx(PeopleLite.set_alias_account)" type="Error">Error: Incompatible runtime entry Tx(PeopleLite.set_alias_account)
 ❯ src/lib/x.ts:1:1</failure>
    </testcase>
    <testcase classname="src/tests/core.test.ts" name="reads &apos;blocks&apos;" time="1">
      <failure message="timeout" type="Error"/>
    </testcase>
    <testcase classname="src/tests/core.test.ts" name="passes" time="1"></testcase>
    <testcase classname="src/tests/core.test.ts" name="skipped" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>`;

const side = (specVersion: number, transactionVersion: number, codeHash: string) => ({
  specName: "people",
  specVersion,
  transactionVersion,
  codeHash,
});

const people: ChainDiff = {
  chain: "people",
  pin: "paritytech/individuality-community@v0.4.0",
  wasm: "people.wasm",
  endpoint: "wss://previewnet.substrate.dev/people",
  descriptor: "previewnet-individuality",
  live: side(3004000, 6, "0xaaaaaaaaaaaa"),
  candidate: side(3005000, 7, "0xbbbbbbbbbbbb"),
  entries: [
    {
      selector: "tx:PeopleLite.set_alias_account",
      change: "changed",
      severity: "breaking",
      sdk: { live: "Identical", candidate: "Incompatible" },
      paths: [{ side: "args", path: "alias" }],
      sdkRef: true,
    },
    {
      selector: "event:Game.NewGame",
      change: "changed",
      severity: "additive",
      sdk: { live: "Identical", candidate: "BackwardsCompatible" },
      paths: [],
      sdkRef: false,
    },
  ],
  extensions: {
    versions: [
      {
        version: 0,
        status: "same",
        breaking: false,
        before: ["CheckNonce"],
        after: ["CheckNonce"],
        added: [],
        removed: [],
        reordered: false,
        retyped: [],
      },
    ],
    moved: [],
    summary: "No change.",
    extrinsicVersions: { removed: [], added: [] },
  },
  missingSurfaces: [],
  pallets: ["Game", "PeopleLite", "System"],
};

const diff: Diff = {
  network: "previewnet",
  descriptors: "@parity/product-sdk-descriptors@0.14.0",
  sdkError: null,
  sdk: [{ name: "@parity/product-sdk-individuality", version: "0.9.0", from: "@pop-e2e/chain-tests", deps: [] }],
  sdkSelectors: { "@parity/product-sdk-individuality": ["tx:PeopleLite.set_alias_account"] },
  chains: [people],
};

const failures = (): Failure[] => failuresFromJunit(JUNIT);

describe("test results", () => {
  it("reads failing cases out of junit, entities decoded", () => {
    const [first, second, ...rest] = failures();
    assert.deepEqual(
      [first, second].map((f) => [f?.file, f?.name]),
      [
        ["src/tests/lite-alias-bind.test.ts", "Lite sign-up > binds the alias"],
        ["src/tests/core.test.ts", "reads 'blocks'"],
      ],
    );
    assert.deepEqual(rest, []);
    assert.match(first?.message ?? "", /Tx\(PeopleLite\.set_alias_account\)/);
  });

  it("reads every junit file in a results directory", () => {
    const dir = tmp("junit-dir-");
    fs.writeFileSync(path.join(dir, "junit-test_a.xml"), JUNIT);
    fs.writeFileSync(path.join(dir, "junit-test_b.xml"), JUNIT.replaceAll("core.test.ts", "other.test.ts"));
    fs.writeFileSync(path.join(dir, "report.xml"), JUNIT);
    assert.equal(readFailures([dir]).length, 4);
    assert.deepEqual(readFailures([path.join(dir, "missing")]), []);
  });

  // vitest writes junit.xml again on every run. The gate runs one test script after
  // another, so without run-chain-tests.sh only the last script's results are left.
  describe("run-chain-tests.sh", () => {
    // A stand-in pnpm: each script writes junit.xml with one case named after itself,
    // and a script whose name has "fail" in it fails that case and exits 1.
    function run(scripts: string[]) {
      const results = tmp("results-");
      const bin = tmp("fake-pnpm-");
      fs.writeFileSync(
        path.join(bin, "pnpm"),
        `#!/usr/bin/env bash
script=$3
echo "$script" >> "${results}/ran.txt"
case "$script" in
  *fail*) body='<failure message="'"$script"' broke"/>'; code=1 ;;
  *) body=''; code=0 ;;
esac
cat > "${results}/junit.xml" <<EOF
<testsuites><testsuite name="s"><testcase classname="src/tests/$script.test.ts" name="$script case">$body</testcase></testsuite></testsuites>
EOF
exit $code
`,
        { mode: 0o755 },
      );
      const out = spawnSync(path.join(HERE, "..", "run-chain-tests.sh"), [results, ...scripts], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      const files = fs.readdirSync(results).filter((f) => f.endsWith(".xml")).sort();
      const read = (f: string) => fs.readFileSync(path.join(results, f), "utf8");
      return { status: out.status, results, files, read };
    }

    it("keeps every script's results, not only the last one's", () => {
      const { status, files, read } = run(["test:first", "test:second", "test:third"]);
      assert.equal(status, 0);
      // No junit.xml is left to be overwritten: each script has its own file, and
      // each file still holds that script's case.
      assert.deepEqual(files, ["junit-test_first.xml", "junit-test_second.xml", "junit-test_third.xml"]);
      for (const name of ["first", "second", "third"]) {
        assert.match(read(`junit-test_${name}.xml`), new RegExp(`name="test:${name} case"`));
      }
    });

    it("stops at the first failing script and keeps its failure and what ran before it", () => {
      const { status, results, files } = run(["test:first", "test:fail-here", "test:never"]);
      assert.equal(status, 1);
      assert.deepEqual(files, ["junit-test_fail-here.xml", "junit-test_first.xml"]);
      assert.deepEqual(fs.readFileSync(path.join(results, "ran.txt"), "utf8").trim().split("\n"), [
        "test:first",
        "test:fail-here",
      ]);
      assert.deepEqual(
        readFailures([results]).map((f) => [f.name, f.message]),
        [["test:fail-here case", "test:fail-here broke"]],
      );
    });
  });
});

describe("report", () => {
  it("links an entry named in the error above one the test merely reaches", () => {
    const [named, other] = failures();
    assert.ok(named && other);
    const nothing = { own: new Set<string>(), viaSdk: new Set<string>() };
    assert.deepEqual(
      linksFor(named, nothing, diff).map((l) => [l.what, l.why]),
      [["tx:PeopleLite.set_alias_account", "named in the error"]],
    );
    // An additive change cannot explain a failure, even when the test reads it.
    assert.deepEqual(linksFor(other, { own: new Set(["event:Game.NewGame"]), viaSdk: new Set() }, diff), []);
  });

  it("links extension changes only on chains the test signs on", () => {
    const [, other] = failures();
    assert.ok(other);
    const [v0] = people.extensions.versions;
    assert.ok(v0);
    const signed: ChainDiff = {
      ...people,
      entries: [],
      extensions: { ...people.extensions, versions: [{ ...v0, status: "changed", breaking: true }] },
    };
    const hub: ChainDiff = { ...signed, chain: "asset-hub", pallets: ["Assets", "System"] };
    const surface = { own: new Set(["tx:PeopleLite.set_alias_account"]), viaSdk: new Set<string>() };
    assert.deepEqual(
      linksFor(other, surface, { ...diff, chains: [signed, hub] }).map((l) => [l.chain, l.why]),
      [["people", "the test signs transactions"]],
    );
  });

  it("does not take a pallet on every diffed chain as the chain the test signs on", () => {
    const [, other] = failures();
    assert.ok(other);
    const [v0] = people.extensions.versions;
    assert.ok(v0);
    const signed: ChainDiff = {
      ...people,
      entries: [],
      extensions: { ...people.extensions, versions: [{ ...v0, status: "changed", breaking: true }] },
    };
    const hub: ChainDiff = { ...people, chain: "asset-hub", entries: [], pallets: ["Assets", "System"] };
    const surface = { own: new Set(["tx:System.remark"]), viaSdk: new Set<string>() };
    assert.deepEqual(linksFor(other, surface, { ...diff, chains: [signed, hub] }), []);
  });

  it("puts the cause next to the failure and offers the product-sdk issue", () => {
    const explained = explainFailures(diff, failures(), TESTS_DIR);
    const md = renderReport(diff, explained, { outcome: "failure", title: "previewnet · target", run: "https://example/run/1" });
    assert.match(md, /lite-alias-bind › Lite sign-up > binds the alias: likely `tx:PeopleLite.set_alias_account` on people \(breaking, named in the error\)/);
    assert.match(md, /core › reads 'blocks': nothing in this diff reaches it/);
    assert.match(md, /\[Open a `runtime-break` issue on paritytech\/product-sdk\]\(https:\/\/github\.com\/paritytech\/product-sdk\/issues\/new\?/);
    assert.match(md, /\| 🔴 \| `tx:PeopleLite.set_alias_account` ★ \| changed at `args.alias` \| Identical → Incompatible \| lite-alias-bind › Lite sign-up > binds the alias \|/);
    assert.match(md, /1 breaking, 1 additive/);
  });

  it("prefills the issue with the breaking changes and the run", () => {
    const explained = explainFailures(diff, failures(), TESTS_DIR);
    const url = new URL(issueUrl(diff, explained, { run: "https://example/run/1" }));
    assert.equal(url.searchParams.get("labels"), "runtime-break");
    assert.equal(url.searchParams.get("title"), "runtime-break: previewnet people 3004000 → 3005000");
    const body = url.searchParams.get("body") ?? "";
    assert.match(body, /Run: https:\/\/example\/run\/1/);
    assert.match(body, /`tx:PeopleLite.set_alias_account` changed at args.alias \(Identical → Incompatible\)/);
    assert.doesNotMatch(body, /Game.NewGame/);
    assert.match(body, /@parity\/product-sdk-individuality@0\.9\.0/);
  });

  it("does not blame the runtime when nothing in the diff breaks the SDK", () => {
    const calm: Diff = { ...diff, chains: [{ ...people, entries: [] }] };
    const md = renderReport(calm, explainFailures(calm, failures(), TESTS_DIR), { outcome: "failure" });
    assert.doesNotMatch(md, /Open a `runtime-break` issue/);
    assert.match(md, /probably not a runtime break/);
  });

  it("does not clear the runtime when no test ran, as when the upgrade was refused", () => {
    const calm: Diff = { ...diff, chains: [{ ...people, entries: [] }] };
    assert.doesNotMatch(renderReport(calm, [], { outcome: "failure" }), /probably not a runtime break/);
  });

  it("does not clear the runtime when a chain could not be diffed", () => {
    const calm: Diff = { ...diff, chains: [{ ...people, entries: [] }, { ...people, chain: "relay", error: "timeout" }] };
    const md = renderReport(calm, explainFailures(calm, failures(), TESTS_DIR), { outcome: "failure" });
    assert.doesNotMatch(md, /probably not a runtime break/);
  });

  it("does not count extension changes on a chain without a descriptor", () => {
    const [v0] = people.extensions.versions;
    assert.ok(v0);
    const relay: ChainDiff = {
      ...people,
      chain: "relay",
      descriptor: null,
      entries: [],
      extensions: { ...people.extensions, versions: [{ ...v0, status: "changed", breaking: true }], summary: "v0 changed." },
    };
    const md = renderReport({ ...diff, chains: [{ ...people, entries: [] }, relay] }, [], { outcome: "failure" });
    assert.doesNotMatch(md, /Open a `runtime-break` issue/);
    assert.match(md, /\*\*Transaction extensions\*\* \(no matching SDK descriptor\): v0 changed\./);
  });

  it("says when the installed SDK could not be read", () => {
    const md = renderReport({ ...diff, sdkError: "ENOENT: no such file" }, []);
    assert.match(md, /Could not read the installed SDK: ENOENT: no such file\. Only transaction extensions are compared\./);
  });

  it("names the endpoint no SDK descriptor points at", () => {
    const md = renderReport({ ...diff, chains: [{ ...people, descriptor: null }] }, []);
    assert.match(md, /No SDK descriptor points at `wss:\/\/previewnet\.substrate\.dev\/people`, so only its extensions are compared\./);
  });

  it("says so when no runtime was upgraded", () => {
    assert.match(renderReport({ ...diff, chains: [] }, []), /No runtime was upgraded in this run/);
  });

  it("writes report.md and report.json next to the diff from the CLI", () => {
    const dir = tmp("runtime-report-");
    fs.writeFileSync(path.join(dir, "diff.json"), JSON.stringify(diff));
    fs.mkdirSync(path.join(dir, "results"));
    fs.writeFileSync(path.join(dir, "results", "junit-test_a.xml"), JUNIT);
    const args = ["--import", "tsx", path.join(HERE, "report.ts"), path.join(dir, "diff.json")];
    const out = execFileSync(process.execPath, [...args, "--junit", path.join(dir, "results"), "--tests-dir", TESTS_DIR], {
      encoding: "utf8",
    });
    assert.match(out, /### Runtime diff/);
    assert.equal(fs.readFileSync(path.join(dir, "report.md"), "utf8").trim(), out.trim());
    const report = readJson(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    assert.ok(report && typeof report === "object" && "failingTests" in report && Array.isArray(report.failingTests));
    assert.equal(report.failingTests.length, 2);
  });

  it("puts a note in the job summary when the diff was not captured", () => {
    const missing = path.join(tmp("runtime-report-"), "diff.json");
    const args = ["--import", "tsx", path.join(HERE, "report.ts"), missing, "--title", "previewnet · target"];
    const out = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.match(out, /### Runtime diff \(previewnet · target\)/);
    assert.match(out, /The diff was not captured in this run\./);
  });
});
