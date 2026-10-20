// The report on a gate run, and the test results it reads. No chain is needed: the
// diff is a fixture, and the test scripts are a stand-in pnpm.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Diff } from "./runtime-diff.ts";
import {
  explainFailures,
  failuresFromJunit,
  issueUrl,
  junitFiles,
  linksFor,
  readFailures,
  renderReport,
} from "./runtime-report.ts";
import { knownBreaks } from "./runtime-watch/diagnosis.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = path.join(HERE, "..", "packages", "chain-tests");
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

const noExtensionChange = {
  versions: [
    {
      version: 0,
      status: "same" as const,
      severity: "none" as const,
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
  watch: null,
  extrinsicVersions: { live: [4, 5], candidate: [4, 5], removed: [], added: [] },
};

const side = (specVersion: number, transactionVersion: number, codeHash: string) => ({
  specName: "people",
  specVersion,
  transactionVersion,
  metadataVersion: 16,
  codeHash,
});

const diff: Diff = {
  network: "previewnet",
  descriptors: "@parity/product-sdk-descriptors@0.14.0",
  sdk: [{ name: "@parity/product-sdk-individuality", version: "0.9.0", from: "@pop-e2e/chain-tests", deps: [] }],
  sdkSelectors: { "@parity/product-sdk-individuality": ["tx:PeopleLite.set_alias_account"] },
  chains: [
    {
      chain: "people",
      pin: "paritytech/individuality-community@v0.4.0",
      wasm: "people.wasm",
      descriptor: "previewnet-individuality",
      live: side(3004000, 6, "0xaaaaaaaaaaaa"),
      candidate: side(3005000, 7, "0xbbbbbbbbbbbb"),
      entries: [
        {
          selector: "tx:PeopleLite.set_alias_account",
          kind: "tx",
          change: "changed",
          severity: "breaking",
          sdk: { live: "Identical", candidate: "Incompatible" },
          paths: [{ side: "args", path: "alias", level: "Incompatible" }],
          sdkRef: true,
        },
        {
          selector: "event:Game.Reported",
          kind: "events",
          change: "changed",
          severity: "partial",
          sdk: { live: "Identical", candidate: "Partial" },
          paths: [{ side: "value", path: "reason", level: "Partial" }],
          sdkRef: false,
        },
        {
          selector: "event:Game.NewGame",
          kind: "events",
          change: "changed",
          severity: "additive",
          sdk: { live: "Identical", candidate: "BackwardsCompatible" },
          paths: [],
          sdkRef: false,
        },
      ],
      extensions: noExtensionChange,
      missingSurfaces: [],
    },
  ],
};

const people = diff.chains[0]!;
const withChain = (base: Diff, chain: Partial<Diff["chains"][number]>): Diff => ({
  ...base,
  chains: [{ ...people, ...chain }],
});

describe("test results", () => {
  it("reads failing cases out of junit, entities decoded", () => {
    const failures = failuresFromJunit(JUNIT);
    assert.deepEqual(
      failures.map((f) => [f.file, f.name]),
      [
        ["src/tests/lite-alias-bind.test.ts", "Lite sign-up > binds the alias"],
        ["src/tests/core.test.ts", "reads 'blocks'"],
      ],
    );
    assert.match(failures[0]!.message, /Tx\(PeopleLite\.set_alias_account\)/);
  });

  it("reads every junit file in a results directory", () => {
    const dir = tmp("junit-dir-");
    fs.writeFileSync(path.join(dir, "junit-test_a.xml"), JUNIT);
    fs.writeFileSync(path.join(dir, "junit-test_b.xml"), JUNIT.replaceAll("core.test.ts", "other.test.ts"));
    fs.writeFileSync(path.join(dir, "report.xml"), JUNIT);
    assert.deepEqual(junitFiles([dir]).map((f) => path.basename(f)), ["junit-test_a.xml", "junit-test_b.xml"]);
    assert.equal(readFailures([dir]).length, 4);
    assert.deepEqual(readFailures([path.join(dir, "missing")]), []);
  });

  // vitest writes junit.xml again on every run. The gate runs one test script after
  // another, so without run-chain-tests.sh only the last script's results are left.
  describe("run-chain-tests.sh", () => {
    const SCRIPT = path.join(HERE, "run-chain-tests.sh");

    // A stand-in pnpm: each script writes junit.xml with one case named after itself,
    // and a script whose name has "fail" in it fails that case and exits 1.
    function fakePnpm(results: string): string {
      const bin = tmp("fake-pnpm-");
      const pnpm = path.join(bin, "pnpm");
      fs.writeFileSync(
        pnpm,
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
      );
      fs.chmodSync(pnpm, 0o755);
      return bin;
    }

    const run = (scripts: string[]) => {
      const results = tmp("results-");
      const bin = fakePnpm(results);
      const out = spawnSync(SCRIPT, [results, ...scripts], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const files = fs.readdirSync(results).filter((f) => f.endsWith(".xml")).sort();
      const read = (f: string) => fs.readFileSync(path.join(results, f), "utf8");
      return { status: out.status, results, files, read };
    };

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
    const [named, other] = failuresFromJunit(JUNIT);
    const nothing = { own: new Set<string>(), viaSdk: new Set<string>() };
    assert.deepEqual(
      linksFor(named!, nothing, diff).map((l) => [l.what, l.why]),
      [["tx:PeopleLite.set_alias_account", "named in the error"]],
    );
    // An additive change cannot explain a failure, even when the test reads it.
    assert.deepEqual(linksFor(other!, { own: new Set(["event:Game.NewGame"]), viaSdk: new Set() }, diff), []);
  });

  it("links a partial change only when the error names it", () => {
    const reads = { own: new Set(["event:Game.Reported"]), viaSdk: new Set<string>() };
    const quiet = { file: null, name: "t", message: "timeout" };
    const loud = { file: null, name: "t", message: "could not decode Game.Reported" };
    assert.deepEqual(linksFor(quiet, reads, diff), []);
    assert.deepEqual(
      linksFor(loud, reads, diff).map((l) => [l.what, l.severity]),
      [["event:Game.Reported", "partial"]],
    );
  });

  it("puts the cause next to the failure and offers the product-sdk issue", () => {
    const explained = explainFailures(diff, failuresFromJunit(JUNIT), TESTS_DIR);
    const md = renderReport(diff, explained, { outcome: "failure", title: "previewnet · target", run: "https://example/run/1" });
    assert.match(md, /lite-alias-bind › Lite sign-up > binds the alias: likely `tx:PeopleLite.set_alias_account` on people \(breaking, named in the error\)/);
    assert.match(md, /core › reads 'blocks': nothing in this diff reaches it/);
    assert.match(md, /\[Open a `runtime-break` issue on paritytech\/product-sdk\]\(https:\/\/github\.com\/paritytech\/product-sdk\/issues\/new\?/);
    assert.match(md, /\| 🔴 \| `tx:PeopleLite.set_alias_account` ★ \| changed at `args.alias` \| Identical → Incompatible \| lite-alias-bind › Lite sign-up > binds the alias \|/);
    assert.match(md, /1 breaking, 1 partial, 1 additive/);
    assert.match(md, /<summary>Partial changes \(may break, depending on the values\)<\/summary>[\s\S]*\| 🟠 \| `event:Game.Reported`/);
  });

  it("prefills the issue with the breaking changes and the run", () => {
    const explained = explainFailures(diff, failuresFromJunit(JUNIT), TESTS_DIR);
    const url = new URL(issueUrl(diff, explained, { run: "https://example/run/1" }));
    assert.equal(url.searchParams.get("labels"), "runtime-break");
    assert.equal(url.searchParams.get("title"), "runtime-break: previewnet people 3004000 → 3005000");
    const body = url.searchParams.get("body")!;
    assert.match(body, /Run: https:\/\/example\/run\/1/);
    assert.match(body, /`tx:PeopleLite.set_alias_account` changed at args.alias \(Identical → Incompatible\)/);
    assert.doesNotMatch(body, /Game.Reported/);
    assert.match(body, /1 partial changes/);
    assert.match(body, /@parity\/product-sdk-individuality@0\.9\.0/);
  });

  it("does not blame the runtime when only partial and additive changes are left", () => {
    const calm = withChain(diff, { entries: people.entries!.slice(1) });
    const md = renderReport(calm, explainFailures(calm, failuresFromJunit(JUNIT), TESTS_DIR), { outcome: "failure" });
    assert.doesNotMatch(md, /Open a `runtime-break` issue/);
    assert.match(md, /probably not a runtime break/);
  });

  it("says so when no runtime was upgraded", () => {
    assert.match(renderReport({ ...diff, chains: [] }, []), /No runtime was upgraded in this run/);
  });

  describe("Runtime Watch known breaks", () => {
    const known = knownBreaks[0]!;
    const split = withChain(diff, {
      entries: [],
      extensions: {
        ...noExtensionChange,
        watch: {
          summary: "split",
          beforeVersions: ["0"],
          afterVersions: ["0", "1"],
          moved: known.scope.pipelineChange.moved,
          before: [],
          after: {},
        },
      },
    });
    const failure = [{ file: null, name: "signs as a person", message: `Error: ${known.canaryError}\n at x` }];
    const onSdk = (version: string): Diff => ({
      ...split,
      sdk: [{ ...split.sdk[0]!, version }],
    });

    it("explains a failure that matches a catalogued break, with the fix and the tracking issues", () => {
      const d = onSdk("0.8.0");
      const md = renderReport(d, explainFailures(d, failure, TESTS_DIR), { outcome: "failure" });
      assert.match(md, new RegExp(`Known break on people\\*\\* \\(Runtime Watch \`${known.id}\`\\)`));
      assert.match(md, /1\. Product SDK must read the highest declared pipeline/);
      assert.match(md, /\[platform-bugs#110\]\(https:\/\/github\.com\/paritytech\/platform-bugs\/issues\/110\)/);
    });

    it("does not match once the SDK carries the fix, or when no test shows the error", () => {
      const fixed = onSdk(known.scope.sdkVersion.maxExclusive);
      assert.doesNotMatch(renderReport(fixed, explainFailures(fixed, failure, TESTS_DIR)), /Known break/);
      const old = onSdk("0.8.0");
      const other = [{ ...failure[0]!, message: "timeout" }];
      assert.doesNotMatch(renderReport(old, explainFailures(old, other, TESTS_DIR)), /Known break/);
    });
  });

  it("writes report.md and report.json next to the diff from the CLI", () => {
    const dir = tmp("runtime-report-");
    fs.writeFileSync(path.join(dir, "diff.json"), JSON.stringify(diff));
    fs.mkdirSync(path.join(dir, "results"));
    fs.writeFileSync(path.join(dir, "results", "junit-test_a.xml"), JUNIT);
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(HERE, "runtime-report.ts"),
        path.join(dir, "diff.json"),
        "--junit",
        path.join(dir, "results"),
        "--tests-dir",
        TESTS_DIR,
      ],
      { encoding: "utf8" },
    );
    assert.match(out, /### Runtime diff/);
    assert.equal(fs.readFileSync(path.join(dir, "report.md"), "utf8").trim(), out.trim());
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).failingTests.length, 2);
  });
});
