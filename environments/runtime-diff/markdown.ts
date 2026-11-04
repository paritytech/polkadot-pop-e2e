// The job summary: each failing test next to what its error names, then each chain's
// diff, and a prefilled product-sdk issue when the run failed on a breaking change.

import path from "node:path";
import type { ChainDiff, Diff, MetadataDiff } from "./diff.ts";
import type { EntryDiff, Severity } from "./entries.ts";
import type { PipelineDiff } from "./extensions.ts";
import type { Failure } from "./junit.ts";
import type { Explained, Link } from "./links.ts";

const PRODUCT_SDK_ISSUES = "https://github.com/paritytech/product-sdk/issues/new";
const ISSUE_LABEL = "runtime-break";
const MAX_ROWS = 40;

type Diffed = Extract<ChainDiff, MetadataDiff>;
const diffed = (diff: Diff): Diffed[] => diff.chains.filter((c): c is Diffed => !("error" in c));

const code = (s: string): string => `\`${s.replaceAll("`", "'")}\``;
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const testLabel = (t: Failure): string => `${path.basename(t.file ?? "?").replace(/\.test\.ts$/, "")} › ${t.name ?? "?"}`;
// Past two names a list of tests stops being read; the count says the same.
const testsText = (tests: Failure[]): string =>
  tests.length > 2 ? `${tests.length} failing tests` : tests.map(testLabel).join("; ");
const spec = (v: number | null): string => (v === null ? "?" : String(v));

function changeText(e: EntryDiff): string {
  if (e.change !== "changed") return e.change;
  const at = e.paths.map((p) => code(`${p.side}${p.path ? `.${p.path}` : ""}`));
  return at.length ? `changed at ${at.join(", ")}` : "changed";
}

const pipelineBreaks = (ext: PipelineDiff): boolean =>
  ext.versions.some((v) => v.breaking) || ext.extrinsicVersions.removed.length > 0;

const linkKey = (l: Pick<Link, "chain" | "what">): string => `${l.chain}|${l.what}`;
const linkText = (l: Link): string => `${code(l.what)} on ${l.chain} (${l.why})`;

/** What breaks the SDK on a chain: breaking entries, and any entry a failing test's error names. */
function breakingOf(chain: Diffed, named: Set<string> = new Set()) {
  return {
    entries: chain.entries.filter((e) => e.severity === "breaking" || named.has(linkKey({ chain: chain.chain, what: e.selector }))),
    // The SDK only signs on chains it has a descriptor for.
    extensions: chain.descriptor !== null && pipelineBreaks(chain.extensions),
    // A removed entry is already listed under its own name.
    missing: chain.missingSurfaces.filter(
      (m) => !m.alsoMissingOnLive && !chain.entries.some((e) => e.change === "removed" && e.selector === m.selector),
    ),
  };
}

const isBreaking = (chain: Diffed, named?: Set<string>): boolean => {
  const b = breakingOf(chain, named);
  return b.entries.length > 0 || b.extensions || b.missing.length > 0;
};

const namedKeys = (explained: Explained[]): Set<string> => new Set(explained.flatMap((t) => t.links.map(linkKey)));

const MARK: Record<Severity, string> = { breaking: "🔴", partial: "🟡", other: "⚪" };

function testsByLink(explained: Explained[]): Map<string, Explained[]> {
  const map = new Map<string, Explained[]>();
  for (const t of explained) for (const l of t.links) map.set(linkKey(l), [...(map.get(linkKey(l)) ?? []), t]);
  return map;
}

function pipelineTable(ext: PipelineDiff): string[] {
  const rows = ext.versions.filter((v) => v.status !== "same");
  if (!rows.length) return [];
  // Bold marks what differs from the other side, which only means something when
  // both sides have the version.
  const list = (ids: string[], other: string[], whole: boolean) =>
    ids.length ? ids.map((id) => (whole || other.includes(id) ? id : `**${id}**`)).join(", ") : "—";
  return [
    "",
    "| version | live | candidate |",
    "|---|---|---|",
    ...rows.map((v) => {
      const whole = v.status !== "changed";
      return `| v${v.version} (${v.status}) | ${list(v.before, v.after, whole)} | ${list(v.after, v.before, whole)} |`;
    }),
  ];
}

function entryTable(entries: EntryDiff[], chain: string, byLink: Map<string, Explained[]>): string[] {
  const rows = entries.slice(0, MAX_ROWS).map((e) => {
    const tests = byLink.get(`${chain}|${e.selector}`) ?? [];
    return (
      `| ${MARK[e.severity]} | ${code(e.selector)}${e.sdkRef ? " ★" : ""} | ${cell(changeText(e))} ` +
      `| ${e.sdk.live} → ${e.sdk.candidate} | ${cell(testsText(tests))} |`
    );
  });
  const more = entries.length > MAX_ROWS ? ["", `${entries.length - MAX_ROWS} more in the artifact's diff.json.`] : [];
  return ["| | entry | change | SDK fit, live → candidate | failing tests |", "|---|---|---|---|---|", ...rows, ...more];
}

// Names the endpoint when no descriptor matched it, so a moved endpoint shows up
// here instead of reading as a chain the SDK does not cover.
function descriptorText(chain: Diffed, diff: Diff): string {
  if (chain.descriptor) return `Checked against ${code(diff.descriptors ?? "?")} ${code(chain.descriptor)}.`;
  if (diff.sdkError) return "Only its extensions are compared.";
  if (diff.descriptors && chain.endpoint) {
    return `No SDK descriptor points at ${code(chain.endpoint)}, so only its extensions are compared.`;
  }
  return "The SDK has no descriptors for this chain, so only its extensions are compared.";
}

function chainSection(chain: ChainDiff, diff: Diff, byLink: Map<string, Explained[]>): string[] {
  if ("error" in chain) return [`#### ${chain.chain}`, "", `Could not diff this chain: ${chain.error}`, ""];
  const { live, candidate, extensions: ext } = chain;
  const short = (hash = "?") => code(`${hash.slice(0, 10)}…`);
  const lines = [
    `#### ${chain.chain}: ${spec(live.specVersion)} → ${spec(candidate.specVersion)}`,
    "",
    `Live ${short(live.codeHash)} → candidate ${short(candidate.codeHash)}${chain.pin ? ` (${code(chain.pin)})` : ""}, ` +
      `transaction_version ${spec(live.transactionVersion)} → ${spec(candidate.transactionVersion)}. ` +
      descriptorText(chain, diff),
    "",
  ];

  const extTests = byLink.get(`${chain.chain}|transaction extensions`) ?? [];
  const { removed, added } = ext.extrinsicVersions;
  const marker = pipelineBreaks(ext)
    ? chain.descriptor !== null
      ? " 🔴 breaking"
      : " (no matching SDK descriptor)"
    : ext.summary === "No change."
      ? ""
      : " 🟢 additive";
  lines.push(
    `**Transaction extensions**${marker}: ${ext.summary}` +
      (removed.length ? ` Extrinsic version ${removed.join(", ")} removed.` : "") +
      (added.length ? ` Extrinsic version ${added.join(", ")} added.` : "") +
      (extTests.length ? ` Failing tests whose error points here: ${testsText(extTests)}.` : ""),
    ...pipelineTable(ext),
    "",
  );

  const gone = chain.missingSurfaces.filter((m) => !m.alsoMissingOnLive);
  const absent = chain.missingSurfaces.filter((m) => m.alsoMissingOnLive);
  if (gone.length) {
    lines.push("**SDK surfaces the candidate no longer has** 🔴", "");
    for (const m of gone) {
      const tests = byLink.get(`${chain.chain}|${m.selector} (gone)`) ?? [];
      lines.push(`- ${code(m.selector)}, read by ${m.packages.join(", ")}${tests.length ? `; failing: ${testsText(tests)}` : ""}`);
    }
    lines.push("");
  }
  if (absent.length) {
    const list = absent.map((m) => code(m.selector)).join(", ");
    lines.push(`SDK selectors live did not have either (read optionally, or already broken): ${list}.`, "");
  }

  if (chain.descriptor) {
    const of = (severity: Severity) => chain.entries.filter((e) => e.severity === severity);
    const [breaking, partial, other] = [of("breaking"), of("partial"), of("other")];
    lines.push(
      chain.entries.length
        ? `**SDK entries:** ${breaking.length} breaking, ${partial.length} may fail for some values, ${other.length} other. ` +
            "★ = the scan found SDK code that reads it, and only ★ entries are graded breaking. The scan does not follow " +
            "aliases (`const query = api.query.Game`), so the SDK can read more than ★ shows."
        : "**SDK entries:** none of the descriptor's entries changed.",
      "",
    );
    if (breaking.length) lines.push(...entryTable(breaking, chain.chain, byLink), "");
    if (partial.length) {
      lines.push(
        "🟡 polkadot-api now checks each value of these, so some values fail and others still work:",
        "",
        ...entryTable(partial, chain.chain, byLink),
        "",
      );
    }
    if (other.length) {
      lines.push(
        "<details><summary>Other changes: the scan found no SDK code that reads them, or polkadot-api still accepts them</summary>",
        "",
        ...entryTable(other, chain.chain, byLink),
        "",
        "</details>",
        "",
      );
    }
  }
  return lines;
}

export function runUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY, GITHUB_SERVER_URL = "https://github.com" } = env;
  return GITHUB_RUN_ID && GITHUB_REPOSITORY ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
}

export interface ReportOptions {
  outcome?: string | undefined;
  title?: string | undefined;
  run?: string | null | undefined;
}

/** A prefilled `runtime-break` issue on product-sdk, as the Runtime Release Contract asks. */
export function issueUrl(diff: Diff, explained: Explained[], { run, title }: ReportOptions = {}): string {
  const named = namedKeys(explained);
  const broken = diffed(diff).filter((c) => isBreaking(c, named));
  const sdk = diff.sdk.filter((p) => p.from === "@pop-e2e/chain-tests").map((p) => `${p.name}@${p.version}`);
  const chains = broken
    .map((c) => `${c.chain} ${spec(c.live.specVersion)} → ${spec(c.candidate.specVersion)}`)
    .join(", ");
  const body = [
    `The Release Gate${title ? ` (${title})` : ""} upgraded a fork of ${diff.network}: ${chains}.`,
    ...(run ? [`Run: ${run}`] : []),
    "",
    `Tested through ${sdk.join(", ")}; descriptors ${diff.descriptors ?? "?"}.`,
    "",
    ...broken.flatMap((c) => {
      const b = breakingOf(c, named);
      return [
        `### ${c.chain} (${c.pin ?? c.wasm})`,
        ...b.missing.map((m) => `- no longer has \`${m.selector}\` (read by ${m.packages.join(", ")})`),
        ...(b.extensions ? [`- transaction extensions: ${c.extensions.summary}`] : []),
        ...b.entries
          .slice(0, 15)
          .map((e) => `- \`${e.selector}\` ${changeText(e).replaceAll("`", "")} (${e.sdk.live} → ${e.sdk.candidate})`),
        ...(b.entries.length > 15 ? [`- … ${b.entries.length - 15} more in the run's job summary`] : []),
        "",
      ];
    }),
    ...(explained.length ? ["Failing tests:"] : []),
    ...explained.slice(0, 15).map((t) => {
      const top = t.links[0];
      return `- ${testLabel(t)}${top ? ` — \`${top.what}\` (${top.why})` : ""}`;
    }),
  ].join("\n");
  const params = new URLSearchParams({
    title: `runtime-break: ${diff.network} ${chains}`,
    labels: ISSUE_LABEL,
    body: body.length > 5000 ? `${body.slice(0, 5000)}\n…` : body,
  });
  return `${PRODUCT_SDK_ISSUES}?${params.toString()}`;
}

const firstLine = (message: string): string => {
  const line = message.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

function failureLines(explained: Explained[]): string[] {
  const lines = [`**${explained.length} failing test${explained.length === 1 ? "" : "s"}, against this diff:**`, ""];
  for (const t of explained) {
    const own = t.links.slice(0, 3);
    const error = firstLine(t.message);
    const verdict = own.length ? own.map(linkText).join("; ") : "the error names nothing in this diff";
    lines.push(`- ✗ ${testLabel(t)}: ${verdict}.${error ? ` Error: ${code(error)}` : ""}`);
  }
  return lines;
}

export function renderReport(diff: Diff, explained: Explained[], options: ReportOptions = {}): string {
  const lines = [`### Runtime diff${options.title ? ` (${options.title})` : ""}`, ""];
  if (diff.sdkError) {
    lines.push(`Could not read the installed SDK: ${cell(diff.sdkError)}. Only transaction extensions are compared.`, "");
  }
  if (!diff.chains.length) {
    lines.push("No runtime was upgraded in this run, so there is nothing to compare.", "");
    return lines.join("\n");
  }
  const failed = options.outcome === "failure" || explained.length > 0;
  if (explained.length) lines.push(...failureLines(explained), "");
  const named = namedKeys(explained);
  if (failed && diffed(diff).some((c) => isBreaking(c, named))) {
    const url = issueUrl(diff, explained, options);
    lines.push(
      `This run failed and the candidate breaks the SDK surface above. [Open a \`${ISSUE_LABEL}\` issue on paritytech/product-sdk](${url}), prefilled from this run.`,
      "",
    );
  } else if (
    explained.length &&
    !diff.sdkError &&
    diff.chains.every((c) => !("error" in c) && c.descriptor !== null && !c.entries.some((e) => e.severity === "partial"))
  ) {
    // Only tests that failed against a full diff clear the metadata. A chain that could
    // not be diffed, or whose endpoint matched no SDK descriptor, had its entries
    // unchecked; a partial entry can fail on the values a test used.
    lines.push(
      "The candidate changes nothing the SDK depends on in a breaking way, so this failure probably does not come from a metadata change. A change in runtime behaviour can still cause it.",
      "",
    );
  }
  const byLink = testsByLink(explained);
  for (const chain of diff.chains) lines.push(...chainSection(chain, diff, byLink));
  return lines.join("\n");
}
