// A run as markdown for the job summary: the verdict first, breaking findings in full,
// pre-existing ones collapsed, ok ones only counted. The JSON has everything.

import type { ChainKey, EntryFinding, Level, PipelineFinding, Report, Run, Use, Verdict } from "../types.ts";

const CHAIN: Record<ChainKey, string> = { individuality: "People", assetHub: "Asset Hub", bulletin: "Bulletin" };

// Past these, a cell stops being read; the count says the rest.
const MAX_USES = 6;
const MAX_NAMES = 5;

const code = (text: string): string => `\`${text}\``;
const shortHash = (hash: string): string => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

const findings = (report: Report): (EntryFinding | PipelineFinding)[] => [...report.entries, ...report.pipelines];
const count = (report: Report, verdict: Verdict): number =>
  findings(report).filter((finding) => finding.verdict === verdict).length;

/** `a.ts:292`, `:318`, `b.ts:132`: a file named once per run of uses in it. */
function readAt(uses: Use[]): string {
  let previous = "";
  const shown = uses.slice(0, MAX_USES).map((use) => {
    const at = use.file === previous ? `:${use.line}` : `${use.file}:${use.line}`;
    previous = use.file;
    return code(at);
  });
  const more = uses.length - shown.length;
  return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ");
}

/** `Identical → **Partial** at `args.call``. */
function levels(before: Level, after: Level, changedAt: string[], emphasise: boolean): string {
  const at = changedAt.length > 0 ? ` at ${changedAt.map(code).join(", ")}` : "";
  return `${before} → ${emphasise ? `**${after}**` : after}${at}`;
}

function entryName(finding: EntryFinding): string {
  const { selector, optional, placedBy } = finding.requirement;
  return `${code(selector)}${optional ? " ?" : ""}${placedBy === "pallet" ? " †" : ""}`;
}

const ENTRY_TABLE = ["| Entry | Live → candidate | Read at |", "|---|---|---|"];

const entryRow = (finding: EntryFinding, emphasise: boolean): string =>
  `| ${entryName(finding)} | ${levels(finding.before, finding.after, finding.changedAt, emphasise)} | ${readAt(finding.requirement.uses)} |`;

const names = (ids: string[]): string =>
  ids.length > MAX_NAMES ? `${ids.slice(0, MAX_NAMES).map(code).join(", ")}, … (${ids.length})` : ids.map(code).join(", ");

/** What the candidate's pipeline does differently from what the SDK signs with. */
function pipelineDifference(pipeline: PipelineFinding): string[] {
  const { version, candidate } = pipeline;
  const expected = pipeline.expected ?? [];
  if (!candidate) return [`The candidate has no v${version}.`];
  const lacks = expected.filter((id) => !candidate.includes(id));
  const adds = candidate.filter((id) => !expected.includes(id));
  const kept = expected.filter((id) => candidate.includes(id));
  const reordered = kept.join() !== candidate.filter((id) => expected.includes(id)).join();
  return [
    ...(lacks.length > 0 ? [`Candidate lacks what the SDK signs with: ${names(lacks)}`] : []),
    ...(adds.length > 0 ? [`Candidate adds: ${names(adds)}`] : []),
    ...(reordered ? ["Candidate reorders the extensions the SDK signs with."] : []),
    ...(pipeline.retyped.length > 0 ? [`Changed type: ${names(pipeline.retyped)}`] : []),
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
    ...pipelines.map((p) => `| transaction extensions v${p.version} | ${levels(p.before, p.after, [], false)} | — |`),
    "</details>",
    "",
  ];
}

function chainSection(report: Report): string[] {
  const entries = report.entries.filter((f) => f.verdict === "breaking");
  const pipelines = report.pipelines.filter((f) => f.verdict === "breaking");
  const breaking = entries.length + pipelines.length;
  const rest = preExisting(report);
  if (breaking === 0 && rest.length === 0) return [];
  return [
    `#### ${CHAIN[report.chain]}${breaking > 0 ? `: ${breaking} breaking` : ""}`,
    "",
    ...(entries.length > 0 ? [...ENTRY_TABLE, ...entries.map((f) => entryRow(f, true)), ""] : []),
    ...pipelines.flatMap(breakingPipeline),
    ...rest,
  ];
}

function unplaced(uses: Use[]): string[] {
  if (uses.length === 0) return [];
  return [
    `<details><summary>Reads on a chain this run does not check (${uses.length})</summary>`,
    "",
    ...uses.map((use) => `- ${code(use.selector)} at ${code(`${use.file}:${use.line}`)}`),
    "</details>",
    "",
  ];
}

export default function renderMarkdown(run: Run): string {
  const breaking = run.reports.reduce((sum, report) => sum + count(report, "breaking"), 0);
  const headline =
    breaking > 0
      ? `### 🔴 Metadata check: ${breaking} breaking change${breaking === 1 ? "" : "s"} for the product-sdk`
      : "### 🟢 Metadata check: no breaking change for the product-sdk";
  const descriptors = run.reports.map((r) => `${code(r.descriptor.chain)} from ${code(shortHash(r.descriptor.codeHash))}`);
  return [
    headline,
    "",
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
