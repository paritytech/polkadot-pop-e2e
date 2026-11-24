import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QuantileSummary } from "./histogram.js";
import type { Sample } from "./prometheus.js";
import type { ChainResult } from "./chain.js";
import { summarizeGameProcessing, summarizePhases, type GameProcessing, type PhaseLoad } from "./phases.js";
import type { HostUsage, SignallingShardResult } from "./signalling.js";
import { STALL_MS, SignallingStats, bump, creditedDeliveries, total } from "./stats.js";
import { summarizeVideoGroups, videoFindings, videoMarkdown, type VideoGroupSummaries } from "./video/report.js";
import { VideoGroups } from "./video/stats.js";
import { iso } from "./time.js";

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
  /** What the counts show without failing the step. */
  notes: string[];
  stats: Omit<SignallingStats, "latency" | "submitRtt" | "subscriptionLifetimeMs" | "acceptedExpiries" | "deliveredUpTo" | "add">;
  expectedDeliveries: number;
  /** Deliveries of statements accepted in the window, a statement replaced before it arrived counted with the one that replaced it. */
  deliveries: number;
  loss: number;
  latencyMs: QuantileSummary;
  submitRttMs: QuantileSummary;
  subscriptionLifetimeMs: QuantileSummary;
  clientLagP99Ms: number;
  /** Per People node over the window: statement-store submit time, CPU cores used, RSS. */
  nodes: Record<string, NodeSummary>;
  hosts: HostUsage | null;
  video: VideoGroupSummaries | null;
}

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
  const unseated: Record<string, number> = {};
  for (const usage of usages) {
    for (const [key, count] of Object.entries(usage.failures)) bump(failures, key, count);
    for (const [key, count] of Object.entries(usage.unseated ?? {})) bump(unseated, key, count);
  }
  const weighted = (pick: (usage: HostUsage) => number) => usages.reduce((sum, usage) => sum + pick(usage) * usage.ghosts, 0) / ghosts;
  return {
    processes: usages.reduce((sum, usage) => sum + usage.processes, 0),
    ghosts,
    failures,
    unseated,
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
  const deliveries = creditedDeliveries(stats);
  const loss = expectedDeliveries > 0 ? Math.max(0, 1 - deliveries / expectedDeliveries) : 1;
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
  const videoResults = results.flatMap((result) => (result.video ? [result.video] : []));
  let video: VideoGroupSummaries | null = null;
  if (videoResults.length > 0) {
    const groups = new VideoGroups();
    for (const result of videoResults) groups.add(result);
    video = summarizeVideoGroups(groups);
  }

  const findings: string[] = [];
  const submitTotal = total(stats.submits);
  const submitFailures = submitTotal - (stats.submits.new ?? 0) - (stats.submits.known ?? 0);
  const latency = stats.latency.summary();
  if (total(stats.connectFailures) > 0) findings.push(`RPC: ${total(stats.connectFailures)} connections rejected`);
  if (total(stats.connectionsLost) > 0) findings.push(`RPC: ${total(stats.connectionsLost)} connections dropped`);
  if (total(stats.subscribeFailures) > 0) findings.push(`RPC: ${total(stats.subscribeFailures)} subscriptions not opened`);
  if (total(stats.subscriptionsEnded) > 0) {
    const lifetime = stats.subscriptionLifetimeMs.summary();
    const formatSeconds = (ms: number | null) => (ms === null ? "–" : `${Math.round(ms / 1000)} s`);
    findings.push(
      `statement store: ${total(stats.subscriptionsEnded)} subscriptions ended early, ${stats.emptySubscriptionEnds} of them before their first statement, after ${formatSeconds(lifetime.p50)} (p50) / ${formatSeconds(lifetime.max)} (max) open`,
    );
  }
  if (stats.silentSubscriptions > 0) findings.push(`statement store: ${stats.silentSubscriptions} of ${stats.subscribed} subscriptions delivered nothing`);
  if (stats.stalledSubscriptions > 0) {
    findings.push(`statement store: ${stats.stalledSubscriptions} of ${stats.subscribed} subscriptions stopped delivering ${STALL_MS / 1000} s or more before the game ended`);
  }
  // The counter's view of a submit that timed out and was accepted late, not a loss.
  const notes = stats.deliveredInWindow > expectedDeliveries ? ["delivery: more arrived than were counted as sent, so some submits that timed out were accepted late"] : [];
  if (hosts && total(hosts.failures) > 0) findings.push(`host: ${total(hosts.failures)} of ${hosts.processes} truapi-host processes failed`);
  if (hosts?.unseated && total(hosts.unseated) > 0) findings.push(`seats: ${total(hosts.unseated)} of ${hosts.ghosts} bots without seats from the chain ${JSON.stringify(hosts.unseated)}`);
  if (stats.linksUp < stats.links) findings.push(`signalling: ${stats.links - stats.linksUp} of ${stats.links} links not up when the game ended`);
  if (submitTotal > 0 && submitFailures / submitTotal > thresholds.maxSubmitFailureRate) {
    findings.push(`submit: ${submitFailures}/${submitTotal} not accepted`);
  }
  if (loss > thresholds.maxLoss) findings.push(`delivery: ${(loss * 100).toFixed(2)}% lost`);
  if ((latency.p95 ?? Infinity) > thresholds.maxP95Ms) findings.push(`delivery: p95 ${latency.p95} ms`);
  const videoVerdict = video ? videoFindings(video.all) : { findings: [], clientBound: false };
  findings.push(...videoVerdict.findings);
  const clientBound = clientLagP99Ms > thresholds.maxClientLagMs || videoVerdict.clientBound;
  if (clientLagP99Ms > thresholds.maxClientLagMs) findings.push(`client: event loop p99 ${clientLagP99Ms.toFixed(0)} ms, add shards`);
  // A machine that sent no result, or started late, makes the target look lossy when it isn't.
  const shardCount = results[0].shard.count;
  const missingShards = shardCount - results.length;
  if (missingShards > 0) findings.push(`client: ${missingShards} of ${shardCount} machines sent no result`);
  const lateShards = results.filter((result) => result.lateMs > 1_000).length;
  if (lateShards > 0) findings.push(`client: ${lateShards} of ${shardCount} machines started over 1 s late`);
  const inconclusive = clientBound || missingShards > 0 || lateShards > 0;

  const { latency: _latency, submitRtt, subscriptionLifetimeMs, acceptedExpiries: _accepted, deliveredUpTo: _deliveredUpTo, ...counts } = stats;
  return {
    layer,
    players,
    shards: results.length,
    verdict: findings.length === 0 ? "pass" : inconclusive ? "inconclusive" : "fail",
    findings,
    notes,
    stats: counts,
    expectedDeliveries,
    deliveries,
    loss,
    latencyMs: latency,
    submitRttMs: submitRtt.summary(),
    subscriptionLifetimeMs: subscriptionLifetimeMs.summary(),
    clientLagP99Ms,
    nodes,
    hosts,
    video,
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
    ...steps.flatMap((step) => step.notes.map((note) => `- ${step.players} players: ${note}`)),
    ...(steps.some((step) => step.notes.length > 0) ? [""] : []),
  ].join("\n");
}

function phasesMarkdown(phases: PhaseLoad[]): string[] {
  if (phases.length === 0) return ["Blocks by phase: no finalized block of the game was read.", ""];
  const percent = (share: number) => `${Math.round(share * 100)}`;
  const withWitness = phases.some((phase) => phase.maxWitnessBytes !== null);
  const withProposals = phases.some((phase) => phase.proposalEnds !== null);
  const header = [
    "Phase",
    "Blocks",
    "Block time p50 / max s",
    "Max extrinsics",
    "Max normal % ref / proof",
    "Max mandatory % ref / proof",
    "Max KB",
    ...(withWitness ? ["Max PoV KB"] : []),
    "Max unincluded",
    "Max credit trees",
    "Max finality lag",
    "Failed extrinsics",
    ...(withProposals ? ["Collator 1 block ends"] : []),
  ];
  const rows = phases.map((phase) =>
    [
      phase.phase,
      `${phase.blocks} (#${phase.firstBlock}–#${phase.lastBlock})`,
      [phase.blockMs.p50, phase.blockMs.max].map((ms) => (ms === null ? "–" : (ms / 1000).toFixed(1))).join(" / "),
      phase.maxExtrinsics,
      `${percent(phase.maxNormal.refTime)} / ${percent(phase.maxNormal.proofSize)}`,
      `${percent(phase.maxMandatory.refTime)} / ${percent(phase.maxMandatory.proofSize)}`,
      (phase.maxBytes / 1024).toFixed(1),
      ...(withWitness ? [phase.maxWitnessBytes === null ? "–" : (phase.maxWitnessBytes / 1024).toFixed(1)] : []),
      phase.maxUnincluded,
      phase.maxCreditTrees,
      phase.maxFinalityLag,
      phase.failedExtrinsics,
      ...(withProposals
        ? [
            Object.entries(phase.proposalEnds ?? {})
              .map(([end, count]) => `${end} ${count}`)
              .join(", ") || "–",
          ]
        : []),
    ].join(" | "),
  );
  return ["Blocks by phase:", "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row} |`), ""];
}

function processingMarkdown({ shuffle, playerProcess, heaviestStep }: GameProcessing): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const parts = [
    shuffle ? `shuffle ${shuffle.blocks} blocks / ${seconds(shuffle.ms)}` : "shuffle –",
    playerProcess
      ? `reports ended #${playerProcess.reportEndBlock}, GameEnded ${playerProcess.gameEndBlock === null ? "not seen" : `#${playerProcess.gameEndBlock}`}: ${playerProcess.blocks} blocks / ${seconds(playerProcess.ms)}`
      : "player processing –",
    heaviestStep
      ? `heaviest step ${Math.round(heaviestStep.share * 100)}% of ${heaviestStep.source === "step call" ? "the step budget" : "a block's ref time"} (#${heaviestStep.block}, ${heaviestStep.source})`
      : "heaviest step –",
  ];
  return `Game processing: ${parts.join("; ")}.`;
}

/** One chain game's result: the timeline of its phases, the transaction bursts, the People blocks of each phase. */
export function chainMarkdown(result: ChainResult): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const phaseRow = (name: string, phase: ChainResult["signUp"] | null) =>
    phase
      ? `| ${name} | ${phase.ok}/${phase.submitted} | ${phase.inTime} | ${phase.inclusionMs.p50 ?? "–"} / ${phase.inclusionMs.p95 ?? "–"} / ${phase.inclusionMs.max ?? "–"} | ${seconds(phase.durationMs)} | ${phase.firstBlock ?? "–"}–${phase.lastBlock ?? "–"} |`
      : `| ${name} | skipped | | | | |`;
  const durations = result.timeline.slice(1).map((entry, i) => `${result.timeline[i].state} ${seconds(entry.at - result.timeline[i].at)}`);
  return [
    `### Chain game with ${result.players} players on ${result.target}: ${result.verdict}`,
    "",
    ...(result.plan
      ? [
          `Target: game ${result.plan.index ?? "next"}, plays at ${iso(result.plan.playsAt)}, registration ends ${iso(result.plan.registrationEnds)}; the run needed ${Math.round(result.plan.neededMs / 1000)} s before it.`,
          "",
        ]
      : []),
    result.findings.length > 0 ? result.findings.map((finding) => `- ${finding}`).join("\n") : "- every sign-up, report and claim was in",
    "",
    ...(result.capacity.length > 0 ? [`**Capacity:** ${result.capacity.join("; ")}.`, ""] : []),
    "| Burst | Succeeded | In time | Inclusion p50 / p95 / max ms | Burst length | Blocks |",
    "|---|---|---|---|---|---|",
    phaseRow("sign-up", result.signUp),
    phaseRow("report", result.report),
    ...(result.claim ? [phaseRow("NFT claim", result.claim.burst)] : []),
    "",
    ...(result.claim
      ? [
          `Credits: ${result.claim.claimable} of ${result.claim.awarded} claimable on Asset Hub ${seconds(result.claim.claimableAfterMs)} after the reports, into collections ${result.claim.collections.join(", ") || "–"}; ${result.claim.claimed} claimed on chain once every player was done.`,
          ...(result.claim.playerMs
            ? [`A player's claims, one at a time: all done in ${[result.claim.playerMs.p50, result.claim.playerMs.p95, result.claim.playerMs.max].map((ms) => (ms === null ? "–" : seconds(ms))).join(" / ")} (p50 / p95 / max).`]
            : []),
          "",
        ]
      : []),
    ...(result.lite
      ? [
          `Lite sign-up: binds this run made ${JSON.stringify(result.lite.binds)} in ${seconds(result.lite.bindMs)}; ${result.lite.withDeposit} of ${result.players} lite bots have a deposit reserved after signing up.`,
          "",
        ]
      : []),
    ...(result.draw
      ? [
          `Prize draw entries: ${result.draw.entries} sign-ups entered, the others didn't ${JSON.stringify(result.draw.skips)} (\`not-member-yet\`: the game can't make the player a member, so the app leaves the ticket out).`,
          ...(result.draw.outcome
            ? [
                `Prize draw: ${result.draw.outcome.draws} draws, ${result.draw.outcome.tickets} bot tickets, ${result.draw.outcome.winners.length} bot wins, ${result.draw.outcome.claimCount} prizes claimed (claim p50 / p95 / max ${result.draw.outcome.claimMs.p50 ?? "–"} / ${result.draw.outcome.claimMs.p95 ?? "–"} / ${result.draw.outcome.claimMs.max ?? "–"} ms, failures ${JSON.stringify(result.draw.outcome.claimFailures)}); the winners own ${result.draw.outcome.prizeBalance} of the prize assets.`,
                `Winners: ${result.draw.outcome.winners.join(", ") || "–"}`,
              ]
            : []),
          "",
        ]
      : []),
    `Phases: ${durations.join(" → ") || "–"}`,
    "",
    ...phasesMarkdown(summarizePhases(result)),
    processingMarkdown(summarizeGameProcessing(result)),
    "",
    ...(result.notes.length > 0 ? ["Notes:", "", ...result.notes.map((note) => `- ${note}`), ""] : []),
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
    .map((layerSteps) => {
      const withVideo = layerSteps.flatMap((step) => (step.video ? [{ players: step.players, video: step.video }] : []));
      return [stepsMarkdown(target, layerSteps), ...(withVideo.length > 0 ? [videoMarkdown(target, withVideo)] : [])].join("\n");
    })
    .join("\n");
  await writeFile(join(dir, "summary.json"), JSON.stringify({ target, thresholds, steps }, null, 2));
  await writeFile(join(dir, "summary.md"), text);
  return text;
}
