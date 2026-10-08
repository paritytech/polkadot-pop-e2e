// Checks the static CPU manager actually split the cores the way network.toml
// asks: every node pod Guaranteed, every node container holding exclusive CPUs
// equal to its limit, and no two containers — or the shared pool — sharing one.
//
//   node pinning.mjs <cpu_manager_state> <pods.json> <node-name>...
//
// Prints a markdown table to stdout; exits 1 with a reason per violation.
import { readFileSync } from "node:fs";

const [statePath, podsPath, ...nodes] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const pods = JSON.parse(readFileSync(podsPath, "utf8")).items;

// "2-3,18-19" -> [2, 3, 18, 19]
const parse = (list) =>
  (list ?? "")
    .split(",")
    .filter(Boolean)
    .flatMap((part) => {
      const [lo, hi = lo] = part.split("-").map(Number);
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    });

const problems = [];
const owner = new Map(); // cpu -> "pod/container"
const shared = new Set(parse(state.defaultCpuSet));
const rows = [];

if (state.policyName !== "static") {
  problems.push(`kubelet CPU manager policy is "${state.policyName}", not static`);
}

for (const name of nodes) {
  const pod = pods.find((p) => p.metadata.name === name);
  if (!pod) {
    problems.push(`${name}: no such pod`);
    continue;
  }
  const qos = pod.status.qosClass;
  const container = pod.spec.containers.find((c) => c.name === name) ?? pod.spec.containers[0];
  const limit = container.resources?.limits?.cpu ?? "-";
  const cpus = parse(state.entries?.[pod.metadata.uid]?.[container.name]);

  if (qos !== "Guaranteed") problems.push(`${name}: QoS ${qos}, so it gets no exclusive cores`);
  if (cpus.length === 0) problems.push(`${name}: no exclusive CPUs assigned`);
  else if (String(cpus.length) !== limit) {
    problems.push(`${name}: ${cpus.length} CPUs pinned, limit is ${limit}`);
  }
  for (const cpu of cpus) {
    if (owner.has(cpu)) problems.push(`${name}: CPU ${cpu} also pinned to ${owner.get(cpu)}`);
    if (shared.has(cpu)) problems.push(`${name}: CPU ${cpu} is also in the shared pool`);
    owner.set(cpu, name);
  }
  rows.push(`| ${name} | ${qos} | ${limit} | ${cpus.join(",") || "-"} |`);
}

console.log("| node | QoS | cpu limit | pinned CPUs |");
console.log("|---|---|---|---|");
for (const row of rows) console.log(row);
console.log(`\nShared pool (reserved + unallocated): \`${state.defaultCpuSet}\``);

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
