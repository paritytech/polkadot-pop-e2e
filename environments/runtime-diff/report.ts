// Explain a gate run against its runtime diff.
//
//   tsx environments/runtime-diff/report.ts <runtime-diff/diff.json> \
//     [--junit packages/chain-tests/test-results] [--tests-dir packages/chain-tests] \
//     [--outcome success|failure] [--title "previewnet · target"]
//
// `--junit` takes junit files or directories, comma-separated. Markdown goes to
// stdout (the workflow appends it to the job summary); report.md and report.json are
// written next to diff.json for the artifact.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isDiff } from "./diff.ts";
import { readJson } from "./json.ts";
import { readFailures } from "./junit.ts";
import { explainFailures } from "./links.ts";
import { renderReport, runUrl } from "./markdown.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    junit: { type: "string", default: "" },
    "tests-dir": { type: "string", default: "packages/chain-tests" },
    outcome: { type: "string" },
    title: { type: "string" },
  },
});
const [diffFile] = positionals;
if (!diffFile) {
  console.error("usage: report.ts <diff.json> [--junit file|dir,...] [--tests-dir dir] [--outcome status] [--title text]");
  process.exit(2);
}
if (!fs.existsSync(diffFile)) {
  console.error(`${diffFile} does not exist: the diff was not captured in this run.`);
  process.exit(0);
}

const diff = readJson(fs.readFileSync(diffFile, "utf8"));
if (!isDiff(diff)) {
  console.error(`${diffFile} is not a runtime diff.`);
  process.exit(1);
}
const failures = readFailures(values.junit.split(",").filter(Boolean));
const explained = explainFailures(diff, failures, values["tests-dir"]);
const markdown = renderReport(diff, explained, { outcome: values.outcome, title: values.title, run: runUrl() });

const dir = path.dirname(diffFile);
fs.writeFileSync(path.join(dir, "report.md"), `${markdown}\n`);
const failingTests = explained.map((t) => ({ ...t, message: t.message.slice(0, 2000) }));
fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify({ ...diff, failingTests }, null, 2)}\n`);
console.log(markdown);
