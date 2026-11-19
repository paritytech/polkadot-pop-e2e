// Sums the runtime-diff artifacts of one gate run: the breaking changes they report, and
// what could not be checked. The workflow downloads every `release-gate-runtime-diff-*`
// artifact into one directory, each in its own subdirectory.
//
//   node environments/runtime-diff/sum-reports.mjs <dir> [--expected <n>]
//
// `--expected` is how many candidates the gate planned. Each planned candidate with no
// artifact directory is unknown. Markdown goes to stdout. With GITHUB_OUTPUT set,
// `breaking=<n>` and `unknown=<n>` are appended to it. An artifact without a diff.json,
// a report.json, or a report.json summary is one unknown. A missing <dir> means none.

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

const walk = (folder) =>
  fs.existsSync(folder)
    ? fs.readdirSync(folder, { withFileTypes: true }).flatMap((dirent) => {
        const file = path.join(folder, dirent.name);
        return dirent.isDirectory() ? walk(file) : [file];
      })
    : [];

const isCount = (value) => Number.isInteger(value) && value >= 0;
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 200);

// The summary report.ts writes into report.json, or null when there is none to read.
function summaryOf(file) {
  try {
    const summary = JSON.parse(fs.readFileSync(file, "utf8")).summary;
    return isCount(summary?.breaking) && isCount(summary?.unknown) && Array.isArray(summary.chains) ? summary : null;
  } catch {
    return null;
  }
}

// One artifact's totals and table rows. An artifact that cannot be checked is one unknown.
function artifactOf(artifactDir) {
  const name = path.basename(artifactDir);
  const files = walk(artifactDir);
  const named = (base) => files.find((file) => path.basename(file) === base);
  const report = named("report.json");
  const summary = report ? summaryOf(report) : null;
  const why = !named("diff.json")
    ? "no diff.json: the diff was not captured"
    : !report
      ? "diff.json but no report.json: the report step did not run"
      : !summary
        ? "report.json has no summary"
        : null;
  if (why) return { name, breaking: 0, unknown: 1, rows: [["-", 0, why]] };
  return {
    name,
    breaking: summary.breaking,
    unknown: summary.unknown,
    rows: summary.chains.map((chain) => [
      chain.chain,
      chain.breaking,
      chain.error ? `not diffed: ${chain.error}` : summary.sdkError ? `SDK not read: ${summary.sdkError}` : "",
    ]),
  };
}

const artifacts = fs.existsSync(dir)
  ? fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => artifactOf(path.join(dir, dirent.name)))
      .sort((left, right) => left.name.localeCompare(right.name))
  : [];

// Planned candidates whose artifact directory never appeared (the job died before upload).
const missing = expected === null ? 0 : Math.max(0, expected - artifacts.length);
const breaking = artifacts.reduce((total, artifact) => total + artifact.breaking, 0);
const unknown = artifacts.reduce((total, artifact) => total + artifact.unknown, 0) + missing;

const lines = ["### Runtime diff: breaking changes", ""];
if (artifacts.length === 0) {
  lines.push("Found no runtime diff artifacts, so nothing was checked.", "");
} else {
  lines.push(
    `**${breaking} breaking, ${unknown} unknown** across ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}. ` +
      "Unknown means a diff was not captured or a chain was not diffed, so its breaking changes are not counted.",
    "",
  );
  for (const artifact of artifacts) {
    lines.push(`#### ${cell(artifact.name)}`, "", "| Chain | Breaking | Note |", "| --- | ---: | --- |");
    for (const [chain, count, note] of artifact.rows) lines.push(`| ${cell(chain)} | ${count} | ${cell(note)} |`);
    lines.push("");
  }
}
if (missing > 0) {
  const one = missing === 1;
  lines.push(`${missing} planned candidate${one ? " has" : "s have"} no runtime diff artifact, so ${one ? "it is" : "they are"} unknown.`, "");
}
console.log(lines.join("\n"));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `breaking=${breaking}\nunknown=${unknown}\n`);
}
