// Which changes in the diff each failing test hit.
//
// Only what the error itself says counts. polkadot-api names the entry it refused
// (`Incompatible runtime entry Tx(Game.sign_up)`), and a node that rejects a
// transaction says so. A static guess at what a test reaches links too many tests to
// changes they never hit, so it is not made.

import type { Diff } from "./diff.ts";
import type { Failure } from "./junit.ts";

export interface Link {
  chain: string;
  what: string;
  why: string;
  score: number;
}

export interface Explained extends Failure {
  links: Link[];
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
 * What in the diff broke one failing test, best first: an entry or a gone SDK surface
 * the error names, or a breaking extension change when the error names the extension
 * or says the transaction was rejected. Extension changes link only on chains the SDK
 * has a descriptor for.
 */
export function linksFor(test: Failure, diff: Diff): Link[] {
  const links: Link[] = [];
  for (const chain of diff.chains) {
    if ("error" in chain) continue;
    const link = (what: string, why: string, score: number) => links.push({ chain: chain.chain, what, why, score });

    for (const e of chain.entries) {
      if (mentions(test.message, e.selector)) link(e.selector, "named in the error", 7);
    }
    // A removed entry is already linked above under its own name.
    const removed = new Set(chain.entries.filter((e) => e.change === "removed").map((e) => e.selector));
    for (const m of chain.missingSurfaces.filter((s) => !s.alsoMissingOnLive && !removed.has(s.selector))) {
      if (mentions(test.message, m.selector)) link(`${m.selector} (gone)`, "named in the error", 7);
    }
    const ext = chain.extensions;
    if (chain.descriptor !== null && (ext.versions.some((v) => v.breaking) || ext.extrinsicVersions.removed.length)) {
      const namedExt = ext.versions.flatMap((v) => v.before).find((id) => test.message.includes(id));
      if (namedExt) link("transaction extensions", `the error names ${namedExt}`, 6);
      else if (REJECTED_TX.test(test.message)) link("transaction extensions", "the error is a rejected transaction", 6);
    }
  }
  return links.sort((a, b) => b.score - a.score || a.what.localeCompare(b.what));
}

export const explainFailures = (diff: Diff, failures: Failure[]): Explained[] =>
  failures.map((t) => ({ ...t, links: linksFor(t, diff) }));
