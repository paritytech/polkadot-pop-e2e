import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuantileSummary } from "./histogram.js";
import type { Sample } from "./prometheus.js";
import type { ChainResult } from "./chain.js";
import type { HostUsage, SignallingShardResult } from "./signalling.js";
import { SignallingStats } from "./stats.js";

/** Limits a step stays within to pass. */
export interface Thresholds {
  maxLoss: number;
  maxP95Ms: number;
  maxSubmitFailureRate: number;
  /** Above this client event-loop delay the ghosts, not the target, may be the limit. */
  maxClientLagMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { maxLoss: 0.01, maxP95Ms: 2_000, maxSubmitFailureRate: 0.01, maxClientLagMs: 250 };

interface NodeSummary {
  submitAvgMs: number | null;
  cpuCores: number | null;
  rssMb: number | null;
  submits: number | null;
}

export interface StepSummary {
  layer: SignallingShardResult["layer"];
  players: number;
  shards: number;
  verdict: "pass" | "fail" | "inconclusive";
  /** What exceeded a threshold, in terms of where it points. */
  findings: string[];
  stats: Omit<SignallingStats, "latency" | "submitRtt" | "add">;
  expectedDeliveries: number;
  loss: number;
  latencyMs: QuantileSummary;
  submitRttMs: QuantileSummary;
  clientLagP99Ms: number;
  /** Per People node over the window: statement-store submit time, CPU cores used, RSS. */
  nodes: Record<string, NodeSummary>;
  hosts: HostUsage | null;
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0);

function nodeSummary(start: Sample, end: Sample, seconds: number): NodeSummary {
  const delta = (name: string) => (name in end && name in start ? end[name] - start[name] : null);
  const submitSum = delta("substrate_sub_statement_store_submit_duration_seconds_sum");
  const submits = delta("substrate_sub_statement_store_submit_duration_seconds_count");
  const cpu = delta("process_cpu_seconds_total");
  return {
    submitAvgMs: submitSum !== null && submits ? (submitSum / submits) * 1000 : null,
    cpuCores: cpu !== null ? cpu / seconds : null,
    rssMb: "process_resident_memory_bytes" in end ? end.process_resident_memory_bytes / 2 ** 20 : null,
    submits,
  };
}

function mergeHosts(results: SignallingShardResult[]): HostUsage | null {
  const usages = results.flatMap((result) => (result.hosts ? [result.hosts] : []));
  if (usages.length === 0) return null;
  const ghosts = usages.reduce((sum, usage) => sum + usage.ghosts, 0);
  const failures: Record<string, number> = {};
  for (const usage of usages) for (const [key, count] of Object.entries(usage.failures)) failures[key] = (failures[key] ?? 0) + count;
  const weighted = (pick: (usage: HostUsage) => number) => usages.reduce((sum, usage) => sum + pick(usage) * usage.ghosts, 0) / ghosts;
  return {
    hosts: usages.reduce((sum, usage) => sum + usage.hosts, 0),
    ghosts,
    failures,
    cpuPercentPerGhost: weighted((usage) => usage.cpuPercentPerGhost),
    rssMbPerGhost: weighted((usage) => usage.rssMbPerGhost),
  };
}

/** One step's shard results combined, with a verdict against `thresholds`. */
export function summarizeStep(results: SignallingShardResult[], thresholds: Thresholds): StepSummary {
  const { players, layer } = results[0];
  const stats = new SignallingStats();
  for (const result of results) stats.add(result.stats);
  const clientLagP99Ms = Math.max(...results.map((result) => result.clientLoopDelayMs.p99));
  const { expectedDeliveries } = stats;
  const loss = expectedDeliveries > 0 ? Math.max(0, 1 - stats.deliveredInWindow / expectedDeliveries) : 1;
  const nodes: Record<string, NodeSummary> = {};
  const metered = results.find((result) => result.metrics);
  if (metered?.metrics) {
    const seconds = (metered.window.end - metered.window.start) / 1000;
    for (const [url, end] of Object.entries(metered.metrics.end)) {
      const start = metered.metrics.start[url];
      if (!("error" in end) && start && !("error" in start)) nodes[url] = nodeSummary(start as Sample, end as Sample, seconds);
    }
  }
  const hosts = mergeHosts(results);

  const findings: string[] = [];
  const submitTotal = total(stats.submits);
  const submitFailures = submitTotal - (stats.submits.new ?? 0) - (stats.submits.known ?? 0);
  const latency = stats.latency.summary();
  if (total(stats.connectFailures) > 0) findings.push(`RPC: ${total(stats.connectFailures)} connections rejected`);
  if (total(stats.connectionsLost) > 0) findings.push(`RPC: ${total(stats.connectionsLost)} connections dropped`);
  if (total(stats.subscribeFailures) > 0) findings.push(`RPC: ${total(stats.subscribeFailures)} subscriptions not opened`);
  if (total(stats.subscriptionsEnded) > 0) findings.push(`statement store: ${total(stats.subscriptionsEnded)} subscriptions ended early`);
  if (stats.silentSubscriptions > 0) findings.push(`statement store: ${stats.silentSubscriptions} of ${stats.subscribed} subscriptions delivered nothing`);
  if (stats.stalledSubscriptions > 0) {
    findings.push(`statement store: ${stats.stalledSubscriptions} of ${stats.subscribed} subscriptions stopped delivering 30 s or more before the game ended`);
  }
  if (hosts && total(hosts.failures) > 0) findings.push(`host: ${total(hosts.failures)} hosts failed`);
  if (submitTotal > 0 && submitFailures / submitTotal > thresholds.maxSubmitFailureRate) {
    findings.push(`submit: ${submitFailures}/${submitTotal} not accepted`);
  }
  if (loss > thresholds.maxLoss) findings.push(`delivery: ${(loss * 100).toFixed(2)}% lost`);
  if ((latency.p95 ?? Infinity) > thresholds.maxP95Ms) findings.push(`delivery: p95 ${latency.p95} ms`);
  const clientBound = clientLagP99Ms > thresholds.maxClientLagMs;
  if (clientBound) findings.push(`client: event loop p99 ${clientLagP99Ms.toFixed(0)} ms, add shards`);

  const { latency: _latency, submitRtt, ...counts } = stats;
  return {
    layer,
    players,
    shards: results.length,
    verdict: findings.length === 0 ? "pass" : clientBound ? "inconclusive" : "fail",
    findings,
    stats: counts,
    expectedDeliveries,
    loss,
    latencyMs: latency,
    submitRttMs: submitRtt.summary(),
    clientLagP99Ms,
    nodes,
    hosts,
  };
}

function stepsMarkdown(target: string, steps: StepSummary[]): string {
  const cell = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "–" : value.toFixed(digits));
  const withHosts = steps.some((step) => step.hosts);
  const rows = steps.map((step) => {
    const node = Object.values(step.nodes)[0];
    return [
      step.players,
      step.verdict,
      `${cell(step.latencyMs.p50)} / ${cell(step.latencyMs.p95)} / ${cell(step.latencyMs.p99)}`,
      `${(step.loss * 100).toFixed(2)}%`,
      cell(step.submitRttMs.p95),
      cell(node?.submitAvgMs, 2),
      cell(node?.cpuCores, 2),
      ...(withHosts ? [`${cell(step.hosts?.cpuPercentPerGhost, 1)}% / ${cell(step.hosts?.rssMbPerGhost)} MB`] : []),
      cell(step.clientLagP99Ms),
      step.findings.join("; ") || "–",
    ].join(" | ");
  });
  const passing = steps.filter((step) => step.verdict === "pass").map((step) => step.players);
  const header = [
    "Players",
    "Verdict",
    "Delivery p50 / p95 / p99 ms",
    "Lost",
    "Submit p95 ms",
    "Node submit avg ms",
    "Node CPU cores",
    ...(withHosts ? ["Host CPU / RSS per ghost"] : []),
    "Client lag p99 ms",
    "Findings",
  ];
  return [
    `### ${steps[0].layer === "host" ? "Host" : "Signalling"} load on ${target}`,
    "",
    `Highest passing player count: **${passing.length > 0 ? Math.max(...passing) : "none"}**`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n");
}

/** One chain game's result: the timeline of its phases, both transaction bursts, block fullness. */
export function chainMarkdown(result: ChainResult): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const phaseRow = (name: string, phase: ChainResult["signUp"] | null) =>
    phase
      ? `| ${name} | ${phase.ok}/${phase.submitted} | ${phase.inTime} | ${phase.inclusionMs.p50 ?? "–"} / ${phase.inclusionMs.p95 ?? "–"} / ${phase.inclusionMs.max ?? "–"} | ${seconds(phase.durationMs)} | ${phase.firstBlock ?? "–"}–${phase.lastBlock ?? "–"} |`
      : `| ${name} | not reached | | | | |`;
  const durations = result.timeline.slice(1).map((entry, i) => `${result.timeline[i].state} ${seconds(entry.at - result.timeline[i].at)}`);
  const fullest = (pick: (block: ChainResult["blocks"][number]) => number) =>
    `${(Math.max(0, ...result.blocks.map(pick)) * 100).toFixed(0)}%`;
  return [
    `### Chain game with ${result.players} players on ${result.target}: ${result.verdict}`,
    "",
    result.findings.length > 0 ? result.findings.map((finding) => `- ${finding}`).join("\n") : "- every sign-up, report and claim was in",
    "",
    "| Burst | Succeeded | In time | Inclusion p50 / p95 / max ms | Burst length | Blocks |",
    "|---|---|---|---|---|---|",
    phaseRow("sign-up", result.signUp),
    phaseRow("report", result.report),
    ...(result.claim ? [phaseRow("NFT claim", result.claim.burst)] : []),
    "",
    ...(result.claim
      ? [`Credits: ${result.claim.claimable} of ${result.claim.awarded} claimable on Asset Hub ${seconds(result.claim.claimableAfterMs)} after the game ended, into collections ${result.claim.collections.join(", ") || "–"}.`, ""]
      : []),
    `Phases: ${durations.join(" → ") || "–"}`,
    "",
    `Fullest block: ${fullest((block) => block.refTime)} of the normal-class ref time, ${fullest((block) => block.proofSize)} of its proof size, ${Math.max(0, ...result.blocks.map((block) => block.extrinsics))} extrinsics.`,
    "",
  ].join("\n");
}

/** Merges every shard result file in `dir` into `summary.json` and `summary.md`; returns the markdown. */
export async function writeSummary(dir: string, thresholds: Thresholds): Promise<string> {
  const files = (await readdir(dir)).filter((file) => /^(signalling|host)\.n\d+\.shard\d+\.json$/.test(file));
  if (files.length === 0) throw new Error(`no signalling or host results in ${dir}`);
  const byStep = new Map<string, SignallingShardResult[]>();
  for (const file of files) {
    const result = JSON.parse(await readFile(join(dir, file), "utf8")) as SignallingShardResult;
    const key = `${result.layer}/${result.players}`;
    byStep.set(key, [...(byStep.get(key) ?? []), result]);
  }
  const steps = [...byStep.values()].sort((a, b) => a[0].players - b[0].players).map((results) => summarizeStep(results, thresholds));
  const target = byStep.values().next().value![0].target;
  const text = (["signalling", "host"] as const)
    .map((layer) => steps.filter((step) => step.layer === layer))
    .filter((layerSteps) => layerSteps.length > 0)
    .map((layerSteps) => stepsMarkdown(target, layerSteps))
    .join("\n");
  await writeFile(join(dir, "summary.json"), JSON.stringify({ target, thresholds, steps }, null, 2));
  await writeFile(join(dir, "summary.md"), text);
  return text;
}
