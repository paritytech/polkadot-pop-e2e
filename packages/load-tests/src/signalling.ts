import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Ghost, type GhostRoom } from "./ghost.js";
import { derivePlayer, type Player } from "./keys.js";
import { gameMs, type Phase, type SignallingProfile } from "./profile.js";
import { scrapeAll, type NodeMetrics } from "./prometheus.js";
import { RpcConnection } from "./rpc.js";
import type { Rooms } from "./seating.js";
import { SignallingStats, bump } from "./stats.js";
import type { Target } from "./target.js";

export interface Shard {
  index: number;
  count: number;
}

export interface StepTiming {
  rampMs: number;
  warmupMs: number;
  drainMs: number;
  cooldownMs: number;
}

export interface StepRun {
  runId: string;
  seed: string;
  steps: number[];
  shard: Shard;
  /** Wall-clock start of the first step, the same in every shard. */
  startAt: number;
  timing: StepTiming;
  profile: SignallingProfile;
  /** How the ghosts' bundles line up: `sync` as the app sends them, or `random`. */
  phase: Phase;
  rooms: Rooms;
  target: Target;
  outDir: string;
}

/** CPU and memory of the truapi-host processes a host layer step started, per ghost they served. */
export interface HostUsage {
  hosts: number;
  ghosts: number;
  /** Hosts that exited with an error, by exit code or signal. */
  failures: Record<string, number>;
  cpuPercentPerGhost: number;
  rssMbPerGhost: number;
}

export interface SignallingShardResult {
  layer: "signalling" | "host";
  runId: string;
  players: number;
  shard: Shard;
  target: string;
  profile: SignallingProfile;
  window: { start: number; end: number };
  /** How late this shard started the step; steps of shards only line up when it is small. */
  lateMs: number;
  stats: SignallingStats;
  clientLoopDelayMs: { p50: number; p99: number; max: number };
  /** Node metrics at the window's start and end, scraped by shard 0 only. */
  metrics?: { start: NodeMetrics; end: NodeMetrics };
  hosts?: HostUsage;
}

/** One step's game as every shard sees it. */
export interface StepGame {
  count: number;
  stepStart: number;
  room: GhostRoom;
}

/** The ghosts one shard plays a step with, however they connect to the chain. */
export interface StepPlayers {
  /** Called at the window's end; the ghosts continue receiving until `leave`. */
  stopSending(): void;
  /** Ends the ghosts, after which `room.stats` contains everything they observed. */
  leave(): Promise<void>;
  hosts?(): HostUsage;
}

export type StartPlayers = (game: StepGame) => Promise<StepPlayers>;

export function stepMs(run: Pick<StepRun, "timing" | "profile">): number {
  const { rampMs, warmupMs, drainMs, cooldownMs } = run.timing;
  return rampMs + warmupMs + gameMs(run.profile) + drainMs + cooldownMs;
}

export const sleepUntil = (at: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

/**
 * Plays each step's game with that many ghosts in total over all shards, one step after the
 * other on a schedule every shard computes alike, and writes one result file per step.
 */
export async function runSteps(run: StepRun, layer: SignallingShardResult["layer"], startPlayers: StartPlayers): Promise<void> {
  await mkdir(run.outDir, { recursive: true });
  for (const [position, count] of run.steps.entries()) {
    const stepStart = run.startAt + position * stepMs(run);
    const result = await runStep(run, layer, count, stepStart, startPlayers);
    const file = join(run.outDir, `${layer}.n${count}.shard${run.shard.index}.json`);
    await writeFile(file, JSON.stringify(result, null, 2));
    const { stats } = result;
    console.log(
      `[${layer}] n=${count} shard ${run.shard.index}/${run.shard.count}: subscribed ${stats.subscribed}, accepted ${stats.acceptedInWindow}, delivered ${stats.deliveredInWindow}, latency p95 ${stats.latency.quantile(0.95)} ms -> ${file}`,
    );
  }
}

async function runStep(
  run: StepRun,
  layer: SignallingShardResult["layer"],
  count: number,
  stepStart: number,
  startPlayers: StartPlayers,
): Promise<SignallingShardResult> {
  const { profile, timing, shard, target } = run;
  const lateMs = Math.max(0, Date.now() - stepStart);
  if (lateMs > 1_000) console.warn(`[${layer}] n=${count}: starting ${lateMs} ms late; shards may not overlap`);
  const windowStart = stepStart + timing.rampMs + timing.warmupMs;
  const window = { start: windowStart, end: windowStart + gameMs(profile) };
  const namespace = `pop-e2e-load/${run.runId}/${layer}/n${count}`;
  const stats = new SignallingStats();
  const seating = { rooms: run.rooms, players: count };
  const room: GhostRoom = { profile, phase: run.phase, namespace, seating, gameStart: windowStart, window, stats };

  await sleepUntil(stepStart);
  const players = await startPlayers({ count, stepStart, room });
  await sleepUntil(window.start);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const metricsStart = shard.index === 0 ? await scrapeAll(target.metrics) : undefined;
  await sleepUntil(window.end);
  loopDelay.disable();
  const metricsEnd = shard.index === 0 ? await scrapeAll(target.metrics) : undefined;
  players.stopSending();
  await sleepUntil(window.end + timing.drainMs);
  await players.leave();

  return {
    layer,
    runId: run.runId,
    players: count,
    shard,
    target: target.label,
    profile,
    window,
    lateMs,
    stats,
    clientLoopDelayMs: {
      p50: loopDelay.percentile(50) / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
      max: loopDelay.max / 1e6,
    },
    ...(metricsStart && metricsEnd && { metrics: { start: metricsStart, end: metricsEnd } }),
    ...(players.hosts && { hosts: players.hosts() }),
  };
}

/**
 * Ghosts on direct People RPC connections, `ghostsPerConnection` to a connection. Connections,
 * not ghosts, are split over shards, so ghosts sharing one stay in one process.
 */
export function rpcGhosts(run: StepRun, ghostsPerConnection: number): StartPlayers {
  const players = new Map<number, Player>();
  const playerAt = (index: number) => players.get(index) ?? players.set(index, derivePlayer(run.seed, index)).get(index)!;
  return async ({ count, stepStart, room }) => {
    const { stats } = room;
    const owned = Array.from({ length: Math.ceil(count / ghostsPerConnection) }, (_, connection) => connection).filter(
      (connection) => connection % run.shard.count === run.shard.index,
    );
    const ghosts: Ghost[] = [];
    const connections: RpcConnection[] = [];
    let leaving = false;
    await Promise.all(
      owned.map(async (connectionIndex, position) => {
        await sleepUntil(stepStart + (position * run.timing.rampMs) / owned.length);
        const url = run.target.rpc[connectionIndex % run.target.rpc.length];
        let connection: RpcConnection;
        try {
          connection = await RpcConnection.open(url, 15_000);
        } catch (error) {
          bump(stats.connectFailures, (error as Error).message);
          return;
        }
        stats.connections++;
        connection.onClose = (reason) => {
          if (!leaving) bump(stats.connectionsLost, reason);
        };
        connections.push(connection);
        const end = Math.min((connectionIndex + 1) * ghostsPerConnection, count);
        for (let index = connectionIndex * ghostsPerConnection; index < end; index++) {
          const ghost = new Ghost(playerAt(index), connection, room);
          ghosts.push(ghost);
          await ghost.join();
        }
      }),
    );
    return {
      stopSending: () => ghosts.forEach((ghost) => ghost.stopSending()),
      async leave() {
        leaving = true;
        await Promise.all(ghosts.map((ghost) => ghost.leave()));
        for (const connection of connections) connection.close();
      },
    };
  };
}
