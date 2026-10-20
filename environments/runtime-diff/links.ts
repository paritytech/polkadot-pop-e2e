// Which changes in the diff each failing test touches.
//
// "Touches" is static and deliberately simple: the selectors a test file reads through
// PAPI (it and the local files it imports), plus everything the product-sdk packages
// it imports read. An error message naming an entry outranks that, because PAPI names
// the entry it refused (`Incompatible runtime entry Tx(Game.sign_up)`).

import fs from "node:fs";
import path from "node:path";
import type { Diff } from "./diff.ts";
import type { Failure } from "./junit.ts";
import { SDK_SCOPE, selectorsIn } from "./sdk.ts";

export interface Surface {
  /** Selectors the test and its local imports read. */
  own: Set<string>;
  /** Selectors the SDK packages it imports read. */
  viaSdk: Set<string>;
}

export interface Link {
  chain: string;
  what: string;
  breaking: boolean;
  why: string;
  score: number;
}

export interface Explained extends Failure {
  links: Link[];
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](?<spec>[^'"]+)['"]/g;

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
  for (let current = queue.shift(); current; current = queue.shift()) {
    if (seen.has(current)) continue;
    seen.add(current);
    const source = fs.readFileSync(current, "utf8");
    for (const s of selectorsIn(source)) selectors.add(s);
    for (const { groups } of source.matchAll(IMPORT)) {
      const spec = groups?.spec ?? "";
      if (spec.startsWith(".")) {
        const next = resolveLocal(current, spec);
        if (next) queue.push(next);
      } else {
        const name = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
        if (SDK_SCOPE.test(name)) sdk.add(name);
      }
    }
  }
  return { selectors, sdk };
}

/** Selectors a package reads, itself and through every SDK package under it. */
function sdkClosure(diff: Diff): (name: string) => Set<string> {
  const deps = new Map<string, string[]>();
  for (const p of diff.sdk) deps.set(p.name, [...(deps.get(p.name) ?? []), ...p.deps]);
  const memo = new Map<string, Set<string>>();
  const closure = (name: string, stack = new Set<string>()): Set<string> => {
    const known = memo.get(name);
    if (known) return known;
    if (stack.has(name)) return new Set();
    stack.add(name);
    const out = new Set(diff.sdkSelectors[name] ?? []);
    for (const dep of deps.get(name) ?? []) for (const s of closure(dep, stack)) out.add(s);
    memo.set(name, out);
    return out;
  };
  return closure;
}

// The names PAPI puts in its errors: `Tx(Game.sign_up)`, `RuntimeCall(DryRunApi_dry_run_call)`.
function mentions(message: string, selector: string): boolean {
  const [, prefix, group = "", name = ""] = /^(\w+):(\w+)\.(\w+)$/.exec(selector) ?? [];
  const needles = prefix === "api" ? [`${group}_${name}`, `${group}\\.${name}`] : [`${group}\\.${name}`];
  return needles.some((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}($|[^A-Za-z0-9_])`).test(message));
}

const REJECTED_TX =
  /InvalidTx|BadProof|BadSigner|Invalid transaction|transaction extension|UnknownTransaction|Transaction is outdated/i;

/**
 * What in the diff most likely broke one failing test, best first. An entry the error
 * names always links. One the test merely reaches links only when the change is
 * breaking: an additive change cannot explain a failure. A test builds a transaction
 * only through something with a `tx:` selector, so only those link to an extension
 * change, unless the error says the transaction was rejected.
 */
export function linksFor(test: Failure, surface: Surface, diff: Diff): Link[] {
  const links: Link[] = [];
  const reaches = (selector: string) => surface.own.has(selector) || surface.viaSdk.has(selector);
  for (const chain of diff.chains) {
    if ("error" in chain) continue;
    const link = (what: string, why: string, score: number, breaking = true) =>
      links.push({ chain: chain.chain, what, breaking, why, score });

    for (const e of chain.entries) {
      const named = mentions(test.message, e.selector);
      const breaking = e.severity === "breaking";
      if (named) link(e.selector, "named in the error", breaking ? 7 : 5, breaking);
      else if (reaches(e.selector) && breaking) {
        link(e.selector, surface.own.has(e.selector) ? "the test reads it" : "the SDK it calls reads it", 3);
      }
    }
    for (const m of chain.missingSurfaces.filter((s) => !s.alsoMissingOnLive)) {
      const named = mentions(test.message, m.selector);
      if (named || reaches(m.selector)) {
        link(`${m.selector} (gone)`, named ? "named in the error" : "read by the SDK it calls", named ? 7 : 3);
      }
    }
    const ext = chain.extensions;
    if (ext.versions.some((v) => v.breaking) || ext.extrinsicVersions.removed.length) {
      const namedExt = ext.versions.flatMap((v) => v.before).find((id) => test.message.includes(id));
      const rejected = REJECTED_TX.test(test.message);
      const signs = [...surface.own, ...surface.viaSdk].some((s) => s.startsWith("tx:"));
      if (namedExt) link("transaction extensions", `the error names ${namedExt}`, 6);
      else if (rejected) link("transaction extensions", "the error is a rejected transaction", 6);
      else if (signs) link("transaction extensions", "the test signs transactions", 2);
    }
  }
  return links.sort((a, b) => b.score - a.score || a.what.localeCompare(b.what));
}

export function explainFailures(diff: Diff, failures: Failure[], testsDir: string): Explained[] {
  const closure = sdkClosure(diff);
  const cache = new Map<string, Surface>();
  const surfaceOf = (file: string | null): Surface => {
    const abs = file ? path.resolve(testsDir, file) : "";
    const known = cache.get(abs);
    if (known) return known;
    let surface: Surface = { own: new Set(), viaSdk: new Set() };
    if (abs && fs.existsSync(abs)) {
      const { selectors, sdk } = testSurface(abs);
      surface = { own: selectors, viaSdk: new Set([...sdk].flatMap((name) => [...closure(name)])) };
    }
    cache.set(abs, surface);
    return surface;
  };
  return failures.map((t) => ({ ...t, links: linksFor(t, surfaceOf(t.file), diff) }));
}
