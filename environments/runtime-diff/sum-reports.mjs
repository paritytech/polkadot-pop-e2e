// Sum the runtime-diff artifacts of one gate run: the breaking changes they report, and
// what could not be checked. The workflow downloads every `release-gate-runtime-diff-*`
// artifact into one directory; download-artifact v4 gives each its own subdirectory.
//
//   node environments/runtime-diff/sum-reports.mjs <dir> [--expected <n>]
//
// `--expected` is how many candidates the gate planned. A candidate with no artifact
// directory at all is unknown, so the count is `n` minus the directories found. Without
// it, nothing is counted as missing.
//
// Markdown goes to stdout (the workflow appends it to the job summary). When
// GITHUB_OUTPUT is set, `breaking=<n>` and `unknown=<n>` are appended to that file.
// An artifact without a diff.json, without a report.json, or whose report.json has no
// summary counts as one unknown. A missing <dir> means no artifacts. Plain Node, no deps.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = () => {
  console.error("usage: sum-reports.mjs <dir> [--expected <n>]");
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { expected: { type: "string" } } });
} catch {
  usage();
}
const dir = parsed.positionals[0];
if (!dir || parsed.positionals.length > 1) usage();
const expected = parsed.values.expected === undefined ? null : Number(parsed.values.expected);
if (expected !== null && !(Number.isInteger(expected) && expected >= 0)) usage();

const walk = (d) =>
  fs.existsSync(d)
    ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const file = path.join(d, e.name);
        return e.isDirectory() ? walk(file) : [file];
      })
    : [];

const isCount = (n) => Number.isInteger(n) && n >= 0;

// The summary report.ts writes into report.json, or null when there is none to read.
function summaryOf(file) {
  try {
    const summary = JSON.parse(fs.readFileSync(file, "utf8")).summary;
    return isCount(summary?.breaking) && isCount(summary?.unknown) && Array.isArray(summary.chains) ? summary : null;
  } catch {
    return null;
  }
}

const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 200);

function artifactOf(artifactDir) {
  const name = path.basename(artifactDir);
  const files = walk(artifactDir);
  const diff = files.find((f) => path.basename(f) === "diff.json");
  const report = files.find((f) => path.basename(f) === "report.json");
  const summary = report ? summaryOf(report) : null;
  const unknownBecause = !diff
    ? "no diff.json: the diff was not captured"
    : !report
      ? "diff.json but no report.json: the report step did not run"
      : !summary
        ? "report.json has no summary"
        : null;
  if (unknownBecause) return { name, breaking: 0, unknown: 1, rows: [["-", 0, unknownBecause]] };
  return {
    name,
    breaking: summary.breaking,
    unknown: summary.unknown,
    rows: summary.chains.map((c) => [
      c.chain,
      c.breaking,
      c.error ? `not diffed: ${c.error}` : summary.sdkError ? `SDK not read: ${summary.sdkError}` : "",
    ]),
  };
}

const artifacts = fs.existsSync(dir)
  ? fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => artifactOf(path.join(dir, e.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
  : [];

// Planned candidates whose artifact directory never appeared (the job died before the
// upload, or uploaded nothing): unknown, with no breaking changes to count.
const missing = expected === null ? 0 : Math.max(0, expected - artifacts.length);

const breaking = artifacts.reduce((n, a) => n + a.breaking, 0);
const unknown = artifacts.reduce((n, a) => n + a.unknown, 0) + missing;

const lines = ["### Runtime diff: breaking changes", ""];
if (artifacts.length === 0) {
  lines.push("Found no runtime diff artifacts, so nothing was checked.", "");
} else {
  lines.push(
    `**${breaking} breaking, ${unknown} unknown** across ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}. ` +
      "Unknown means a diff was not captured or a chain was not diffed, so its breaking changes are not counted.",
    "",
  );
  for (const a of artifacts) {
    lines.push(`#### ${cell(a.name)}`, "", "| Chain | Breaking | Note |", "| --- | ---: | --- |");
    for (const [chain, count, note] of a.rows) lines.push(`| ${cell(chain)} | ${count} | ${cell(note)} |`);
    lines.push("");
  }
}
if (missing > 0) {
  lines.push(`${missing} planned candidate${missing === 1 ? " has" : "s have"} no runtime diff artifact, so ${missing === 1 ? "it is" : "they are"} unknown.`, "");
}
console.log(lines.join("\n"));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `breaking=${breaking}\nunknown=${unknown}\n`);
}
