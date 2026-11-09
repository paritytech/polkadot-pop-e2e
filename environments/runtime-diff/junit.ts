// Failing tests out of vitest's junit results. run-chain-tests.sh keeps one
// junit-<script>.xml per test script, because vitest writes junit.xml again on each run.

import fs from "node:fs";
import path from "node:path";

export interface Failure {
  file: string | null;
  name: string | null;
  message: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e] ?? match;
  });

const attr = (tag: string, name: string): string | null => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? null : unescapeXml(value);
};

const TESTCASE = /<testcase\b(?<attrs>[^>]*?)(?:\/>|>(?<body>[\s\S]*?)<\/testcase>)/g;
const FAILURE = /<(failure|error)\b(?<attrs>[^>]*?)(?:\/>|>(?<text>[\s\S]*?)<\/\1>)/;

/** Failing test cases in one junit document, with the failure text. */
export function failuresFromJunit(xml: string): Failure[] {
  return [...xml.matchAll(TESTCASE)].flatMap(({ groups }) => {
    const failure = FAILURE.exec(groups?.body ?? "")?.groups;
    if (!failure) return [];
    const attrs = groups?.attrs ?? "";
    const message = [attr(failure.attrs ?? "", "message") ?? "", unescapeXml(failure.text ?? "")];
    return [{ file: attr(attrs, "classname"), name: attr(attrs, "name"), message: message.join("\n").trim() }];
  });
}

/** The failures in every junit file the paths name: files as given, directories as their junit*.xml. */
export function readFailures(paths: string[]): Failure[] {
  const files = paths.flatMap((p) => {
    if (!fs.existsSync(p)) return [];
    if (!fs.statSync(p).isDirectory()) return [p];
    return fs
      .readdirSync(p)
      .filter((f) => /^junit.*\.xml$/.test(f))
      .sort()
      .map((f) => path.join(p, f));
  });
  return files.flatMap((f) => failuresFromJunit(fs.readFileSync(f, "utf8")));
}
