// What a candidate runtime changes for the product-sdk the gate tests through.
//
//   tsx environments/runtime-diff/capture.ts <candidate-manifest.json> <upgrades.env> \
//     --out runtime-diff [--ports ppn/config/ports.env] [--rpc chain=url|file,...] \
//     [--tests-dir packages/chain-tests]
//
// The gate runs this after "Decide which runtimes to upgrade" and before the upgrade,
// while the fork still runs the code it took from live. report.ts joins the result
// with the test results. Diagnosis only: an error is recorded, never fatal.

import fs from "node:fs";
import { parseArgs } from "node:util";
import { capture, forkPorts, readPlan } from "./diff.ts";
import { readJson } from "./json.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "runtime-diff" },
    ports: { type: "string" },
    rpc: { type: "string", default: "" },
    "tests-dir": { type: "string", default: "packages/chain-tests" },
  },
});
const [manifestFile, planFile] = positionals;
if (!manifestFile || !planFile) {
  console.error("usage: capture.ts <candidate-manifest.json> <upgrades.env> --out <dir> [--ports file] [--rpc chain=url,...]");
  process.exit(2);
}

const rpc = new Map(values.rpc.split(",").flatMap((pair) => {
  const [chain = "", url = ""] = pair.split("=");
  return chain && url ? [[chain, url] as const] : [];
}));
const portOf = values.ports ? forkPorts(fs.readFileSync(values.ports, "utf8")) : () => undefined;

const result = await capture({
  manifest: readJson(fs.readFileSync(manifestFile, "utf8")),
  plan: fs.existsSync(planFile) ? readPlan(fs.readFileSync(planFile, "utf8")) : [],
  liveSource: (chain) => {
    const port = portOf(chain);
    return rpc.get(chain) ?? (port ? `http://127.0.0.1:${port}` : undefined);
  },
  out: values.out,
  testsDir: values["tests-dir"],
});

for (const c of result.chains) {
  if ("error" in c) {
    console.error(`${c.chain}: could not diff: ${c.error}`);
    continue;
  }
  const breaking = c.entries.filter((e) => e.severity === "breaking").length;
  console.error(
    `${c.chain}: ${c.live.specVersion ?? "?"} -> ${c.candidate.specVersion ?? "?"}; ${breaking} breaking, ` +
      `${c.entries.length - breaking} additive SDK entries; extensions: ${c.extensions.summary}`,
  );
}
