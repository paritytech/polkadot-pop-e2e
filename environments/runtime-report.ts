// Explain a gate run against its runtime diff.
//
//   tsx environments/runtime-report.ts <runtime-diff/diff.json> \
//     [--junit packages/chain-tests/test-results] [--tests-dir packages/chain-tests] \
//     [--outcome success|failure] [--title "previewnet · target"]
//
// Joins what runtime-diff.ts captured before the upgrade with the chain-test results:
// every failing test is put next to the diff entries and extension changes it touches,
// so the summary says which change most likely broke it. Markdown goes to stdout (the
// workflow appends it to the job summary); report.md and report.json are written next
// to diff.json for the artifact.
//
// `--junit` takes junit files or directories, comma-separated. A directory is read for
// every junit*.xml in it: run-chain-tests.sh keeps one file per test script, because
// vitest writes junit.xml again on each run.
//
// "Touches" is static and deliberately simple: the selectors a test file reads through
// PAPI (it and the local files it imports), plus everything the product-sdk packages it
// imports read. An error message naming an entry outranks that, because PAPI names the
// entry it refused (`Incompatible runtime entry Tx(Game.sign_up)`).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SDK_SCOPE, parseArgs, selectorsIn, type ChainDiff, type Diff, type EntryDiff } from "./runtime-diff.ts";
import { matchKnownBreak, type KnownBreak } from "./runtime-watch/diagnosis.ts";

const PRODUCT_SDK_ISSUES = "https://github.com/paritytech/product-sdk/issues/new";
const ISSUE_LABEL = "runtime-break";
const MAX_ROWS = 40;

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------

export interface Failure {
  file: string | null;
  name: string | null;
  message: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]!) : null;
};

/** Failing test cases from vitest's junit.xml, with the failure text. */
export function failuresFromJunit(xml: string): Failure[] {
  const out: Failure[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] ?? "";
    const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    if (!failure) continue;
    out.push({
      file: attr(m[1]!, "classname"),
      name: attr(m[1]!, "name"),
      message: [attr(failure[2]!, "message") ?? "", unescapeXml(failure[3] ?? "")].join("\n").trim(),
    });
  }
  return out;
}

/** Every junit file the arguments name: files as given, directories as their junit*.xml. */
export function junitFiles(paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!fs.existsSync(p)) return [];
    if (!fs.statSync(p).isDirectory()) return [p];
    return fs
      .readdirSync(p)
      .filter((f) => /^junit.*\.xml$/.test(f))
      .sort()
      .map((f) => path.join(p, f));
  });
}

/** The failures across every junit file, in file order. */
export function readFailures(paths: string[]): Failure[] {
  return junitFiles(paths).flatMap((f) => failuresFromJunit(fs.readFileSync(f, "utf8")));
}

// ---------------------------------------------------------------------------
// What each test touches
// ---------------------------------------------------------------------------

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function resolveLocal(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  const stem = base.replace(/\.(m?js|ts)$/, "");
  return [base, `${stem}.ts`, `${stem}.mts`, `${stem}.js`, path.join(base, "index.ts")].find(
    (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
  );
}

/** A test file's own selectors (through its local imports) and the SDK packages it imports. */
export function testSurface(file: string): { selectors: Set<string>; sdk: Set<string> } {
  const selectors = new Set<string>();
  const sdk = new Set<string>();
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = fs.readFileSync(current, "utf8");
    for (const s of selectorsIn(source)) selectors.add(s);
    for (const [, spec = ""] of source.matchAll(IMPORT)) {
      if (spec.startsWith(".")) {
        const next = resolveLocal(current, spec);
        if (next) queue.push(next);
      } else {
        const name = spec
          .split("/")
          .slice(0, spec.startsWith("@") ? 2 : 1)
          .join("/");
        if (SDK_SCOPE.test(name)) sdk.add(name);
      }
    }
  }
  return { selectors, sdk };
}

/** Selectors a package reads, itself and through every SDK package under it. */
function sdkClosure(diff: Diff): (name: string) => Set<string> {
  const deps = new Map<string, string[]>();
  for (const p of diff.sdk ?? []) deps.set(p.name, [...(deps.get(p.name) ?? []), ...(p.deps ?? [])]);
  const memo = new Map<string, Set<string>>();
  const closure = (name: string, stack = new Set<string>()): Set<string> => {
    const known = memo.get(name);
    if (known) return known;
    if (stack.has(name)) return new Set();
    stack.add(name);
    const out = new Set(diff.sdkSelectors?.[name] ?? []);
    for (const dep of deps.get(name) ?? []) for (const s of closure(dep, stack)) out.add(s);
    memo.set(name, out);
    return out;
  };
  return closure;
}

// The names PAPI puts in its errors: `Tx(Game.sign_up)`, `RuntimeCall(DryRunApi_dry_run_call)`.
const mentions = (message: string, selector: string): boolean => {
  const [prefix, rest = ""] = selector.split(":");
  const [group, name] = rest.split(".");
  const needles = prefix === "api" ? [`${group}_${name}`, rest] : [rest];
  return needles.some((n) => new RegExp(`(^|[^A-Za-z0-9_])${n.replace(".", "\\.")}($|[^A-Za-z0-9_])`).test(message));
};

const REJECTED_TX = /InvalidTx|BadProof|BadSigner|Invalid transaction|transaction extension|UnknownTransaction|Transaction is outdated/i;

export interface Surface {
  own: Set<string>;
  viaSdk: Set<string>;
}

export interface Link {
  chain: string;
  what: string;
  severity: EntryDiff["severity"];
  why: string;
  score: number;
}

export interface Explained extends Failure {
  links: Link[];
}

const SEVERITY_SCORE = { breaking: 2, partial: 1, additive: 0 } as const;

/**
 * Rank what in the diff most likely broke one failing test. An entry the error names
 * always links. One the test merely reaches links only when the change is breaking:
 * an additive change cannot explain a failure, and a partial one breaks only some
 * values, so without the error naming it, it is a guess. A test only builds a
 * transaction through something with a `tx:` selector, so only those are linked to an
 * extension pipeline change unless the error says the transaction was rejected.
 */
export function linksFor(test: Failure, surface: Surface, diff: Diff): Link[] {
  const links: Link[] = [];
  for (const chain of diff.chains ?? []) {
    if (chain.error) continue;
    for (const e of chain.entries ?? []) {
      const named = mentions(test.message, e.selector);
      const own = surface.own.has(e.selector);
      const viaSdk = surface.viaSdk.has(e.selector);
      if (!named && !((own || viaSdk) && e.severity === "breaking")) continue;
      links.push({
        chain: chain.chain,
        what: e.selector,
        severity: e.severity,
        why: named ? "named in the error" : own ? "the test reads it" : "the SDK it calls reads it",
        score: (named ? 4 : 0) + SEVERITY_SCORE[e.severity] + (own || viaSdk ? 1 : 0),
      });
    }
    for (const m of chain.missingSurfaces ?? []) {
      if (m.alsoMissingOnLive) continue;
      const named = mentions(test.message, m.selector);
      if (!named && !surface.own.has(m.selector) && !surface.viaSdk.has(m.selector)) continue;
      links.push({
        chain: chain.chain,
        what: `${m.selector} (gone)`,
        severity: "breaking",
        why: named ? "named in the error" : "read by the SDK it calls",
        score: (named ? 4 : 0) + 3,
      });
    }
    const pipelines = chain.extensions?.versions ?? [];
    if (pipelines.some((v) => v.severity === "breaking") || chain.extensions?.extrinsicVersions?.removed?.length) {
      const signs = [...surface.own, ...surface.viaSdk].some((s) => s.startsWith("tx:"));
      const rejected = REJECTED_TX.test(test.message);
      const namedExt = pipelines.flatMap((v) => v.before).find((id) => test.message.includes(id));
      if (signs || rejected || namedExt) {
        links.push({
          chain: chain.chain,
          what: "transaction extensions",
          severity: "breaking",
          why: namedExt
            ? `the error names ${namedExt}`
            : rejected
              ? "the error is a rejected transaction"
              : "the test signs transactions",
          score: (namedExt || rejected ? 4 : 0) + 2,
        });
      }
    }
  }
  return links.sort((a, b) => b.score - a.score || a.what.localeCompare(b.what));
}

export function explainFailures(diff: Diff, failures: Failure[], testsDir: string): Explained[] {
  const closure = sdkClosure(diff);
  const cache = new Map<string | null, Surface>();
  const surfaceOf = (file: string | null): Surface => {
    let surface = cache.get(file);
    if (!surface) {
      const abs = file && path.resolve(testsDir, file);
      if (!abs || !fs.existsSync(abs)) surface = { own: new Set(), viaSdk: new Set() };
      else {
        const { selectors, sdk } = testSurface(abs);
        surface = { own: selectors, viaSdk: new Set([...sdk].flatMap((name) => [...closure(name)])) };
      }
      cache.set(file, surface);
    }
    return surface;
  };
  return failures.map((t) => ({ ...t, links: linksFor(t, surfaceOf(t.file), diff) }));
}

/**
 * The Runtime Watch catalogue entry these failures show, per chain: the catalogued
 * error in a failing test, the same pipeline change, and an SDK older than the fix.
 */
export function knownBreaksFor(diff: Diff, explained: Explained[]): Array<{ chain: string; knownBreak: KnownBreak }> {
  const sdkVersion = diff.sdk.find((p) => p.name === "@parity/product-sdk-individuality")?.version;
  if (!sdkVersion || !explained.length) return [];
  const errors = explained.map((t) => t.message);
  return diff.chains.flatMap((c) => {
    const knownBreak = c.error ? null : matchKnownBreak(errors, c.extensions?.watch ?? null, sdkVersion);
    return knownBreak ? [{ chain: c.chain, knownBreak }] : [];
  });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const code = (s: unknown): string => `\`${String(s).replaceAll("`", "'")}\``;
const cell = (s: unknown): string => String(s).replaceAll("|", "\\|").replaceAll("\n", " ");
const short = (hash: string | undefined): string => (hash ? `${hash.slice(0, 10)}…` : "?");
const testLabel = (t: Failure): string => `${path.basename(t.file ?? "?").replace(/\.test\.ts$/, "")} › ${t.name}`;
// Past two names a list of tests stops being read; the count says the same.
const testsText = (tests: Failure[]): string =>
  tests.length > 2 ? `${tests.length} failing tests` : tests.map(testLabel).join("; ");

const ICON = { breaking: "🔴", partial: "🟠", additive: "🟢" } as const;

const changeText = (e: EntryDiff): string => {
  if (e.change !== "changed") return e.change;
  const at = e.paths.map((p) => `${p.side}${p.path ? `.${p.path}` : ""}`);
  return at.length ? `changed at ${at.map(code).join(", ")}` : "changed";
};

const breakingOf = (chain: ChainDiff) => ({
  entries: (chain.entries ?? []).filter((e) => e.severity === "breaking"),
  pipelines: (chain.extensions?.versions ?? []).filter((v) => v.severity === "breaking"),
  extrinsic: chain.extensions?.extrinsicVersions?.removed ?? [],
  missing: (chain.missingSurfaces ?? []).filter((m) => !m.alsoMissingOnLive),
});

const isBreaking = (chain: ChainDiff): boolean => {
  const b = breakingOf(chain);
  return b.entries.length + b.pipelines.length + b.extrinsic.length + b.missing.length > 0;
};

function failingTestsByEntry(explained: Explained[]): Map<string, Explained[]> {
  const map = new Map<string, Explained[]>();
  for (const t of explained) {
    for (const l of t.links) {
      const key = `${l.chain}|${l.what}`;
      map.set(key, [...(map.get(key) ?? []), t]);
    }
  }
  return map;
}

function pipelineTable(ext: NonNullable<ChainDiff["extensions"]>): string[] {
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

function entryRows(entries: EntryDiff[], chain: string, byEntry: Map<string, Explained[]>): string[] {
  return entries.slice(0, MAX_ROWS).map((e) => {
    const tests = byEntry.get(`${chain}|${e.selector}`) ?? [];
    return (
      `| ${ICON[e.severity]} | ${code(e.selector)}${e.sdkRef ? " ★" : ""} | ${cell(changeText(e))} ` +
      `| ${e.sdk.live} → ${e.sdk.candidate} | ${cell(testsText(tests))} |`
    );
  });
}

function entryTable(
  title: string | null,
  entries: EntryDiff[],
  chain: string,
  byEntry: Map<string, Explained[]>,
): string[] {
  if (!entries.length) return [];
  const header = ["| | entry | change | SDK fit, live → candidate | failing tests |", "|---|---|---|---|---|"];
  const more = entries.length > MAX_ROWS ? ["", `${entries.length - MAX_ROWS} more in the artifact's diff.json.`] : [];
  const table = [...header, ...entryRows(entries, chain, byEntry), ...more];
  return title ? [`<details><summary>${title}</summary>`, "", ...table, "", "</details>", ""] : [...table, ""];
}

function chainSection(chain: ChainDiff, diff: Diff, byEntry: Map<string, Explained[]>): string[] {
  const head = `#### ${chain.chain}: ${chain.live?.specVersion ?? "?"} → ${chain.candidate?.specVersion ?? "?"}`;
  if (chain.error || !chain.extensions || !chain.live || !chain.candidate) {
    return [head, "", `Could not diff this chain: ${chain.error ?? "no result"}`, ""];
  }
  const lines = [
    head,
    "",
    `Live ${code(short(chain.live.codeHash))} → candidate ${code(short(chain.candidate.codeHash))}` +
      `${chain.pin ? ` (${code(chain.pin)})` : ""}, transaction_version ${chain.live.transactionVersion} → ` +
      `${chain.candidate.transactionVersion}. ` +
      (chain.descriptor
        ? `Checked against ${code(diff.descriptors)} ${code(chain.descriptor)}.`
        : "The SDK has no descriptors for this chain, so only its extensions are compared."),
    "",
  ];

  const ext = chain.extensions;
  const extBreaking = ext.versions.some((v) => v.severity === "breaking") || ext.extrinsicVersions.removed.length;
  const extTests = byEntry.get(`${chain.chain}|transaction extensions`) ?? [];
  lines.push(
    `**Transaction extensions**${extBreaking ? " 🔴 breaking" : ext.summary === "No change." ? "" : " 🟢 additive"}: ${ext.summary}` +
      (ext.extrinsicVersions.removed.length ? ` Extrinsic version ${ext.extrinsicVersions.removed.join(", ")} removed.` : "") +
      (ext.extrinsicVersions.added.length ? ` Extrinsic version ${ext.extrinsicVersions.added.join(", ")} added.` : "") +
      (extTests.length ? ` Failing tests that sign transactions: ${testsText(extTests)}.` : ""),
    ...pipelineTable(ext),
    "",
  );

  const missing = chain.missingSurfaces ?? [];
  const gone = missing.filter((m) => !m.alsoMissingOnLive);
  const absent = missing.filter((m) => m.alsoMissingOnLive);
  if (gone.length) {
    lines.push("**SDK surfaces the candidate no longer has** 🔴", "");
    for (const m of gone) {
      const tests = byEntry.get(`${chain.chain}|${m.selector} (gone)`) ?? [];
      lines.push(
        `- ${code(m.selector)}, read by ${m.packages.join(", ")}${tests.length ? `; failing: ${testsText(tests)}` : ""}`,
      );
    }
    lines.push("");
  }
  if (absent.length) {
    lines.push(
      `SDK selectors live did not have either (read optionally, or already broken): ${absent.map((m) => code(m.selector)).join(", ")}.`,
      "",
    );
  }

  if (chain.descriptor) {
    const entries = chain.entries ?? [];
    const of = (s: EntryDiff["severity"]) => entries.filter((e) => e.severity === s);
    const [breaking, partial, additive] = [of("breaking"), of("partial"), of("additive")];
    lines.push(
      entries.length
        ? `**SDK entries:** ${breaking.length} breaking, ${partial.length} partial, ${additive.length} additive. ` +
            "Partial: polkadot-api accepts some values and refuses others. ★ = the SDK's code reads it."
        : "**SDK entries:** none of the descriptor's entries changed.",
      "",
      ...entryTable(null, breaking, chain.chain, byEntry),
      ...entryTable("Partial changes (may break, depending on the values)", partial, chain.chain, byEntry),
      ...entryTable("Additive changes", additive, chain.chain, byEntry),
    );
  }
  return lines;
}

export function runUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
}

interface ReportOptions {
  outcome?: string | undefined;
  title?: string | undefined;
  run?: string | null | undefined;
}

/** A prefilled `runtime-break` issue on product-sdk, as the Runtime Release Contract asks. */
export function issueUrl(diff: Diff, explained: Explained[], { run, title }: ReportOptions = {}): string {
  const broken = diff.chains.filter((c) => !c.error && isBreaking(c));
  const sdk = (diff.sdk ?? []).filter((p) => p.from === "@pop-e2e/chain-tests").map((p) => `${p.name}@${p.version}`);
  const chains = broken.map((c) => `${c.chain} ${c.live?.specVersion} → ${c.candidate?.specVersion}`).join(", ");
  const known = knownBreaksFor(diff, explained);
  const body = [
    `The Release Gate${title ? ` (${title})` : ""} upgraded a fork of ${diff.network}: ${chains}.`,
    run ? `Run: ${run}` : null,
    "",
    `Tested through ${sdk.join(", ")}; descriptors ${diff.descriptors}.`,
    "",
    ...known.map(({ chain, knownBreak }) => `Runtime Watch known break on ${chain}: ${knownBreak.id}. ${knownBreak.explanation}\n`),
    ...broken.flatMap((c) => {
      const b = breakingOf(c);
      const partial = (c.entries ?? []).filter((e) => e.severity === "partial").length;
      return [
        `### ${c.chain} (${c.pin ?? c.wasm})`,
        ...b.missing.map((m) => `- no longer has \`${m.selector}\` (read by ${m.packages.join(", ")})`),
        ...(b.pipelines.length || b.extrinsic.length ? [`- transaction extensions: ${c.extensions?.summary}`] : []),
        ...b.entries
          .slice(0, 15)
          .map((e) => `- \`${e.selector}\` ${changeText(e).replaceAll("`", "")} (${e.sdk.live} → ${e.sdk.candidate})`),
        ...(b.entries.length > 15 ? [`- … ${b.entries.length - 15} more in the run's job summary`] : []),
        ...(partial ? [`- ${partial} partial changes (some values refused) in the run's job summary`] : []),
        "",
      ];
    }),
    explained.length ? "Failing tests:" : null,
    ...explained
      .slice(0, 15)
      .map((t) => `- ${testLabel(t)}${t.links[0] ? ` — likely \`${t.links[0].what}\` (${t.links[0].why})` : ""}`),
  ]
    .filter((l) => l !== null)
    .join("\n");
  const params = new URLSearchParams({
    title: `runtime-break: ${diff.network} ${chains}`,
    labels: ISSUE_LABEL,
    body: body.length > 5000 ? `${body.slice(0, 5000)}\n…` : body,
  });
  return `${PRODUCT_SDK_ISSUES}?${params}`;
}

const linkKey = (l: Link): string => `${l.chain}|${l.what}`;
const linkText = (l: Link): string => `${code(l.what)} on ${l.chain} (${l.severity}, ${l.why})`;
const firstLine = (message: string): string => {
  const line = message.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/**
 * One line per failing test. A link every failing test shares — most of the suite
 * goes through the same attestation fixture and so the same SDK — says nothing about
 * any one of them, so it is listed once above the tests instead of on each.
 */
function failureLines(explained: Explained[]): string[] {
  const shared =
    explained.length > 1
      ? explained[0]!.links.filter(
          (l) =>
            l.why !== "named in the error" && explained.every((t) => t.links.some((m) => linkKey(m) === linkKey(l))),
        )
      : [];
  const sharedKeys = new Set(shared.map(linkKey));
  const lines = [`**${explained.length} failing test${explained.length === 1 ? "" : "s"}, against this diff:**`, ""];
  if (shared.length) {
    lines.push(
      `Every failing test reaches ${shared.slice(0, 5).map(linkText).join("; ")}${shared.length > 5 ? `, and ${shared.length - 5} more` : ""}.`,
      "",
    );
  }
  for (const t of explained) {
    const own = t.links.filter((l) => !sharedKeys.has(linkKey(l))).slice(0, 3);
    const error = firstLine(t.message);
    const verdict = own.length
      ? `likely ${own.map(linkText).join("; ")}`
      : shared.length
        ? "only the shared changes above reach it"
        : "nothing in this diff reaches it, so look outside the runtime";
    lines.push(`- ✗ ${testLabel(t)}: ${verdict}.${error ? ` Error: ${code(error)}` : ""}`);
  }
  return lines;
}

function knownBreakLines(diff: Diff, explained: Explained[]): string[] {
  return knownBreaksFor(diff, explained).flatMap(({ chain, knownBreak }) => [
    `**Known break on ${chain}** (Runtime Watch ${code(knownBreak.id)}): ${knownBreak.explanation}`,
    "",
    ...knownBreak.fix.map((step, i) => `${i + 1}. ${step}`),
    "",
    `Tracking: ${knownBreak.tracking.map((t) => `[${t.label}](${t.url})`).join(", ") || "none yet"}.`,
    "",
  ]);
}

export function renderReport(diff: Diff, explained: Explained[], { outcome, title, run }: ReportOptions = {}): string {
  const lines = [`### Runtime diff${title ? ` (${title})` : ""}`, ""];
  const chains = diff.chains ?? [];
  if (!chains.length) {
    lines.push("No runtime was upgraded in this run, so there is nothing to compare.", "");
    return lines.join("\n");
  }
  const failed = outcome === "failure" || explained.length > 0;
  const breaking = chains.some((c) => !c.error && isBreaking(c));

  if (explained.length) lines.push(...failureLines(explained), "");
  lines.push(...knownBreakLines(diff, explained));
  if (failed && breaking) {
    lines.push(
      `This run failed and the candidate breaks the SDK surface above. [Open a \`${ISSUE_LABEL}\` issue on paritytech/product-sdk](${issueUrl(diff, explained, { run, title })}), prefilled from this run.`,
      "",
    );
  } else if (failed) {
    lines.push(
      "The candidate changes nothing the SDK depends on in a breaking way, so this failure is probably not a runtime break.",
      "",
    );
  }

  const byEntry = failingTestsByEntry(explained);
  for (const chain of chains) lines.push(...chainSection(chain, diff, byEntry));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [diffFile] = positional;
  if (!diffFile) {
    console.error(
      "usage: runtime-report.ts <diff.json> [--junit file|dir,...] [--tests-dir dir] [--outcome status] [--title text]",
    );
    process.exit(2);
  }
  if (!fs.existsSync(diffFile)) {
    console.error(`${diffFile} does not exist: the diff was not captured in this run.`);
    process.exit(0);
  }
  const diff = JSON.parse(fs.readFileSync(diffFile, "utf8")) as Diff;
  const failures = readFailures((flags.junit ?? "").split(",").filter(Boolean));
  const explained = explainFailures(diff, failures, flags["tests-dir"] ?? "packages/chain-tests");
  const markdown = renderReport(diff, explained, { outcome: flags.outcome, title: flags.title, run: runUrl() });
  const dir = path.dirname(diffFile);
  fs.writeFileSync(path.join(dir, "report.md"), `${markdown}\n`);
  fs.writeFileSync(
    path.join(dir, "report.json"),
    `${JSON.stringify({ ...diff, failingTests: explained.map(({ message, ...t }) => ({ ...t, message: message.slice(0, 2000) })) }, null, 2)}\n`,
  );
  console.log(markdown);
}
