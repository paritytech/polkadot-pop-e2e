// A run as markdown for the job summary: the verdict first, breaking findings in full,
// pre-existing ones collapsed, ok ones only counted, then what the upgrade changed,
// collapsed. The JSON has the rest, up to its own limits.

import { listChange } from "../diff/index.ts";
import type { ExtrinsicVersionChange, TypeChange } from "../diff/types.ts";
import type { Verdict } from "../regression/types.ts";
import type { ChainKey, Level } from "../types.ts";
import type { RuntimeAccess } from "../runtime-access/types.ts";
import type { EntryFinding, PipelineFinding, Report, Run } from "./types.ts";

const CHAIN: Record<ChainKey, string> = { individuality: "People", assetHub: "Asset Hub", bulletin: "Bulletin" };

// Past these, a cell stops being read; the count says the rest.
const MAX_ACCESSES = 6;
const MAX_NAMES = 5;
const MAX_TYPE_ROWS = 5;

const MARK: Record<Verdict, string> = { breaking: "🔴", "pre-existing": "🟡", ok: "🟢" };

const code = (text: string): string => `\`${text}\``;
/** In a table cell: a `|`, even in code, would end the cell. */
const cellCode = (text: string): string => code(text.replaceAll("|", "\\|"));
const shortHash = (hash: string): string => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

const findings = (report: Report): (EntryFinding | PipelineFinding)[] => [...report.entries, ...report.pipelines];
const count = (report: Report, verdict: Verdict): number =>
  findings(report).filter((finding) => finding.verdict === verdict).length;

/** `a.ts:292`, `:318`, `b.ts:132`: a file named once per run of accesses in it. */
function readAt(accesses: RuntimeAccess[]): string {
  let previous = "";
  const shown = accesses.slice(0, MAX_ACCESSES).map((access) => {
    const at = access.file === previous ? `:${access.line}` : `${access.file}:${access.line}`;
    previous = access.file;
    return code(at);
  });
  const more = accesses.length - shown.length;
  return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ");
}

/**
 * Where an entry's types changed, for its row: the path all its changes share, `args.call`
 * (6 changes), or each side they are on. Not for an added or removed entry: its level says it.
 */
function changedAt(finding: EntryFinding): string {
  const { change } = finding;
  if (change?.status !== "changed") return "";
  const paths = change.types.map((type) => type.path.split("."));
  const [first = [], ...rest] = paths;
  const shared: string[] = [];
  for (const [i, segment] of first.entries()) {
    if (!rest.every((other) => other[i] === segment)) break;
    shared.push(segment);
  }
  const where = shared.length > 0 ? [shared.join(".")] : [...new Set(paths.map((segments) => segments[0] ?? ""))];
  const count = paths.length > 1 || change.truncated ? ` (${paths.length}${change.truncated ? "+" : ""} changes)` : "";
  return ` at ${where.map(code).join(", ")}${count}`;
}

/** `Identical → **Partial**`. */
const levels = (before: Level, after: Level, emphasise: boolean): string =>
  `${before} → ${emphasise ? `**${after}**` : after}`;

function entryName(finding: EntryFinding): string {
  const { selector, optional, placedBy } = finding.requirement;
  return `${code(selector)}${optional ? " ?" : ""}${placedBy === "pallet" ? " †" : ""}`;
}

const ENTRY_TABLE = ["| Entry | Live → candidate | Read at |", "|---|---|---|"];

const entryRow = (finding: EntryFinding, emphasise: boolean): string =>
  `| ${entryName(finding)} | ${levels(finding.before, finding.after, emphasise)}${changedAt(finding)} | ${readAt(finding.requirement.accesses)} |`;

const listOf = (items: string[]): string =>
  items.length > MAX_NAMES ? `${items.slice(0, MAX_NAMES).join(", ")}, … (${items.length})` : items.join(", ");

const names = (ids: string[]): string => listOf(ids.map(code));

/** Extensions added or removed, each once; where a list has one more than once, how often each has it: `A` (2 → 1). */
function counted(ids: string[], before: readonly string[], after: readonly string[]): string {
  const times = (list: readonly string[], id: string) => list.filter((other) => other === id).length;
  return listOf(
    [...new Set(ids)].map((id) => {
      const [from, to] = [times(before, id), times(after, id)];
      return from > 1 || to > 1 ? `${code(id)} (${from} → ${to})` : code(id);
    }),
  );
}

/** An extension version's identifiers, or that it has none. */
const extensions = (ids: string[]): string => (ids.length > 0 ? names(ids) : "no extensions");

/** What the candidate's pipeline does differently from what the SDK signs with. */
function pipelineDifference(pipeline: PipelineFinding): string[] {
  const { version, candidate } = pipeline;
  const expected = pipeline.expected ?? [];
  if (!candidate) return [`The candidate has no v${version}.`];
  const { added, removed, reordered } = listChange(expected, candidate);
  return [
    ...(removed.length > 0 ? [`Candidate lacks what the SDK signs with: ${counted(removed, expected, candidate)}`] : []),
    ...(added.length > 0 ? [`Candidate adds: ${counted(added, expected, candidate)}`] : []),
    ...(reordered ? ["Candidate reorders the extensions the SDK signs with."] : []),
    ...(pipeline.retypedFromSdk.length > 0 ? [`Changed type: ${names(pipeline.retypedFromSdk)}`] : []),
  ];
}

/**
 * The three pipelines side by side. Struck through: what the SDK signs with and the
 * candidate lacks. Bold: what the candidate has and the SDK does not sign with.
 */
function pipelineTable(pipeline: PipelineFinding): string[] {
  const expected = pipeline.expected ?? [];
  const live = pipeline.live ?? [];
  const candidate = pipeline.candidate ?? [];
  const rows = Array.from({ length: Math.max(expected.length, live.length, candidate.length) }, (_, i) => {
    const sdk = expected[i];
    const theirs = candidate[i];
    const sdkCell = sdk === undefined ? "—" : candidate.includes(sdk) ? sdk : `~~${sdk}~~`;
    const candidateCell = theirs === undefined ? "—" : expected.includes(theirs) ? theirs : `**${theirs}**`;
    return `| ${i + 1} | ${sdkCell} | ${live[i] ?? "—"} | ${candidateCell} |`;
  });
  return ["| # | SDK (D) | Live | Candidate |", "|---|---|---|---|", ...rows];
}

function breakingPipeline(pipeline: PipelineFinding): string[] {
  // Two trailing spaces: a line break inside the paragraph.
  const difference = pipelineDifference(pipeline).map((line) => `${line}  `);
  return [
    `**Transaction extensions v${pipeline.version}: breaking** (${pipeline.before} → ${pipeline.after})  `,
    ...difference,
    "",
    "<details><summary>Full pipelines</summary>",
    "",
    ...pipelineTable(pipeline),
    "</details>",
    "",
  ];
}

function preExisting(report: Report): string[] {
  const entries = report.entries.filter((f) => f.verdict === "pre-existing");
  const pipelines = report.pipelines.filter((f) => f.verdict === "pre-existing");
  if (entries.length + pipelines.length === 0) return [];
  return [
    `<details><summary>🟡 Pre-existing (${entries.length + pipelines.length}): broken on live already, not caused by this upgrade</summary>`,
    "",
    ...ENTRY_TABLE,
    ...entries.map((f) => entryRow(f, false)),
    ...pipelines.map((p) => `| transaction extensions v${p.version} | ${levels(p.before, p.after, false)} | — |`),
    "</details>",
    "",
  ];
}

/** Where types differ, a row each, up to a few; the first row names what they belong to. */
function typeRows(name: string, types: TypeChange[], truncated: boolean): string[] {
  const rows = types
    .slice(0, MAX_TYPE_ROWS)
    .map(
      (type, index) =>
        `| ${index === 0 ? name : ""} | ${cellCode(type.path)} | ${type.before === null ? "—" : cellCode(type.before)} | ` +
        `${type.after === null ? "—" : cellCode(type.after)} |`,
    );
  const more = types.length - rows.length;
  if (more === 0 && !truncated) return rows;
  // report.json lists up to its limit; past it, the changes are in neither.
  const rest = [...(more > 0 ? [`${more} more in report.json`] : []), ...(truncated ? ["more past its limit"] : [])];
  return [...rows, `| | … ${rest.join(", and ")} | | |`];
}

function entryChangeRows(finding: EntryFinding): string[] {
  const { change } = finding;
  if (!change) return [];
  const status = change.status === "changed" ? "" : ` (${change.status})`;
  const name = `${MARK[finding.verdict]} ${code(finding.requirement.selector)}${status}`;
  // Added or removed with nothing to encode, as a call without arguments: `()` on the side that has it.
  if (change.types.length === 0) {
    const side = (status: string) => (change.status === status ? code("()") : "—");
    return [`| ${name} | — | ${side("removed")} | ${side("added")} |`];
  }
  return typeRows(name, change.types, change.truncated);
}

/** What the candidate did to one extension version, against live; the types it changed go to the table. */
function pipelineChangeLine(finding: PipelineFinding): string {
  const { change } = finding;
  if (!change) return "";
  const [live, candidate] = [change.live ?? [], change.candidate ?? []];
  const what =
    change.status === "added"
      ? [`new, with ${extensions(change.added)}`]
      : change.status === "removed"
        ? [`gone; live had ${extensions(change.removed)}`]
        : [
            ...(change.removed.length > 0 ? [`removes ${counted(change.removed, live, candidate)}`] : []),
            ...(change.added.length > 0 ? [`adds ${counted(change.added, live, candidate)}`] : []),
            ...(change.reordered ? ["reorders the rest"] : []),
            ...(change.retyped.length > 0 ? [`retypes ${names(change.retyped.map((extension) => extension.identifier))}`] : []),
          ];
  return `- ${MARK[finding.verdict]} Transaction extensions v${change.version}: ${what.join("; ")}`;
}

/** Which extrinsic versions the candidate stopped or started accepting. No grade, so no verdict. */
function extrinsicVersionLine({ added, removed }: ExtrinsicVersionChange): string {
  const what = [
    ...(removed.length > 0 ? [`removes ${names(removed.map(String))}`] : []),
    ...(added.length > 0 ? [`adds ${names(added.map(String))}`] : []),
  ];
  return `- ⚪ Extrinsic versions: ${what.join("; ")} (not graded)`;
}

/** Everything the candidate changed within what the SDK uses, whatever its verdict. Collapsed: the JSON lists more. */
function changes(report: Report): string[] {
  const entries = report.entries.filter((f) => f.change);
  const pipelines = report.pipelines.filter((f) => f.change);
  const { extrinsicVersions } = report;
  if (entries.length + pipelines.length === 0 && !extrinsicVersions) return [];
  // An extension has no verdict of its own: its version's is the one that covers it.
  const extensionRows = pipelines.flatMap((f) =>
    (f.change?.retyped ?? []).flatMap((extension) =>
      typeRows(`${MARK[f.verdict]} v${f.version} ${code(extension.identifier)}`, extension.types, extension.truncated),
    ),
  );
  const tableRows = [...entries.flatMap(entryChangeRows), ...extensionRows];
  const counts = [
    ...(entries.length > 0 ? [`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`] : []),
    ...(pipelines.length > 0 ? [`${pipelines.length} extension version${pipelines.length === 1 ? "" : "s"}`] : []),
    ...(extrinsicVersions ? ["extrinsic versions"] : []),
  ];
  const lines = [...(extrinsicVersions ? [extrinsicVersionLine(extrinsicVersions)] : []), ...pipelines.map(pipelineChangeLine)];
  return [
    `<details><summary>What changed between live and candidate (${counts.join(", ")})</summary>`,
    "",
    ...lines,
    ...(lines.length > 0 ? [""] : []),
    ...(tableRows.length > 0 ? ["| Entry / extension | Where | Live | Candidate |", "|---|---|---|---|", ...tableRows] : []),
    "</details>",
    "",
  ];
}

function chainSection(report: Report): string[] {
  const entries = report.entries.filter((f) => f.verdict === "breaking");
  const pipelines = report.pipelines.filter((f) => f.verdict === "breaking");
  const breaking = entries.length + pipelines.length;
  const rest = [...preExisting(report), ...changes(report)];
  if (breaking === 0 && rest.length === 0) return [];
  return [
    `#### ${CHAIN[report.chain]}${breaking > 0 ? `: ${breaking} breaking` : ""}`,
    "",
    ...(entries.length > 0 ? [...ENTRY_TABLE, ...entries.map((f) => entryRow(f, true)), ""] : []),
    ...pipelines.flatMap(breakingPipeline),
    ...rest,
  ];
}

function unplaced(accesses: RuntimeAccess[]): string[] {
  if (accesses.length === 0) return [];
  return [
    `<details><summary>Reads on a chain this run does not check (${accesses.length})</summary>`,
    "",
    ...accesses.map((access) => `- ${code(access.selector)} at ${code(`${access.file}:${access.line}`)}`),
    "</details>",
    "",
  ];
}

export default function renderMarkdown(run: Run): string {
  if (run.reports.length === 0 && run.failed.length === 0) {
    return "### ⚪ Metadata check: no runtime upgraded in this run";
  }
  const breaking = run.reports.reduce((sum, report) => sum + count(report, "breaking"), 0);
  const headline =
    breaking > 0
      ? `### 🔴 Metadata check: ${breaking} breaking change${breaking === 1 ? "" : "s"} for the product-sdk`
      : "### 🟢 Metadata check: no breaking change for the product-sdk";
  const failed = run.failed.map(({ chain, error }) => `> ⚠️ ${code(chain)} was not checked: ${error}`);
  // Not graded, so the headline stays as it is; but the SDK may build one of these versions.
  const stopsAccepting = run.reports.flatMap(({ chain, extrinsicVersions }) => {
    const removed = extrinsicVersions?.removed ?? [];
    if (removed.length === 0) return [];
    const versions = `extrinsic version${removed.length === 1 ? "" : "s"} ${names(removed.map(String))}`;
    return [`> ⚪ ${CHAIN[chain]}: the candidate stops accepting ${versions} (not graded)`];
  });
  const notes = [...failed, ...stopsAccepting];
  const descriptors = run.reports.map((r) => `${code(r.descriptor.chain)} from ${code(shortHash(r.descriptor.codeHash))}`);
  return [
    headline,
    "",
    ...(notes.length > 0 ? [...notes, ""] : []),
    "| Chain | Runtime (live → candidate) | 🔴 Breaking | 🟡 Pre-existing | 🟢 OK |",
    "|---|---|---|---|---|",
    ...run.reports.map(
      (r) =>
        `| ${CHAIN[r.chain]} | ${r.live.specVersion} → ${r.candidate.specVersion} | ` +
        `${count(r, "breaking")} | ${count(r, "pre-existing")} | ${count(r, "ok")} |`,
    ),
    "",
    ...run.reports.flatMap(chainSection),
    ...unplaced(run.unplaced),
    `<sub>D: ${descriptors.join(", ")} · ${code("?")} optional read · ${code("†")} chain inferred from the pallet</sub>`,
  ].join("\n");
}
