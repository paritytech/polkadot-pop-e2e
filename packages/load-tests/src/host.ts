import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hostMnemonic } from "./keys.js";
import type { Phase, SignallingProfile } from "./profile.js";
import type { Seating } from "./seating.js";
import type { HostUsage, StartPlayers, StepRun } from "./signalling.js";
import { sleepUntil } from "./time.js";
import { bump, type SignallingStats } from "./stats.js";

/** The product the Jollity app signs statements as on each network. */
export const PRODUCT_IDS = { previewnet: "dim2.testnet", "paseo-next-v2": "dim2.paseo" } as const;

/** What one host's ghost script plays: written by the runner, read by `host-ghost.ts`. */
export interface HostGhostPlan {
  profile: SignallingProfile;
  phase: Phase;
  namespace: string;
  seating: Seating;
  gameStart: number;
  window: { start: number; end: number };
  /** Ghost `k` of the host is player `firstPlayer + k` and its product account `k`. */
  firstPlayer: number;
  ghosts: number;
  joinAt: number[];
  stopAt: number;
  leaveAt: number;
  resultPath: string;
}

export interface HostOptions {
  ghostsPerHost: number;
  productId: string;
  binary: string;
}

const SCRIPT = resolve(import.meta.dirname, "host-ghost.ts");
const EXIT_GRACE_MS = 60_000;

type ProcessTable = Map<number, { parent: number; cpuSeconds: number; rssKb: number }>;

/** CPU seconds and RSS of every process, keyed by pid, with each process's parent. */
async function readProcessTable(): Promise<ProcessTable> {
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,ppid=,time=,rss="]);
  const table: ProcessTable = new Map();
  for (const line of stdout.trim().split("\n")) {
    const [pid, parent, time, rss] = line.trim().split(/\s+/);
    // `[DD-]HH:MM:SS` on Linux, `MM:SS.ss` on macOS.
    const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
    const cpuSeconds = clock.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400;
    table.set(Number(pid), { parent: Number(parent), cpuSeconds, rssKb: Number(rss) });
  }
  return table;
}

/** CPU seconds and RSS of `root` and every process below it, such as a host's bun script. */
function treeUsage(table: ProcessTable, root: number): { cpuSeconds: number; rssKb: number } {
  const usage = { cpuSeconds: 0, rssKb: 0 };
  for (const [pid, entry] of table) {
    let ancestor: number | undefined = pid;
    while (ancestor && ancestor !== root) ancestor = table.get(ancestor)?.parent;
    if (ancestor !== root) continue;
    usage.cpuSeconds += entry.cpuSeconds;
    usage.rssKb += entry.rssKb;
  }
  return usage;
}

/** The hosts of `count` bots that shard `shard` runs, dealt to shards in turn, and their bots. */
export function shardHosts(count: number, ghostsPerHost: number, shard: { index: number; count: number }): Array<{ host: number; ghosts: number[] }> {
  return Array.from({ length: Math.ceil(count / ghostsPerHost) }, (_, host) => host)
    .filter((host) => host % shard.count === shard.index)
    .map((host) => ({
      host,
      ghosts: Array.from({ length: Math.min(ghostsPerHost, count - host * ghostsPerHost) }, (_, ghost) => host * ghostsPerHost + ghost),
    }));
}

/**
 * Ghosts inside `truapi-host signing-host --script host-ghost.ts` processes, `ghostsPerHost` to a
 * host, each signing and submitting through its host as the app does. Hosts, not ghosts, are
 * split over shards.
 */
export function hostGhosts(run: StepRun, options: HostOptions): StartPlayers {
  return async ({ count, stepStart, room }) => {
    const { ghostsPerHost } = options;
    const owned = shardHosts(count, ghostsPerHost, run.shard);
    const ownedGhosts = owned.reduce((sum, { ghosts }) => sum + ghosts.length, 0);
    const workDir = resolve(run.outDir, "hosts", `n${count}`);
    await mkdir(workDir, { recursive: true });
    const exits: Array<Promise<string | null>> = [];
    const processes: ChildProcess[] = [];
    const resultPaths: string[] = [];
    let joined = 0;
    for (const { host, ghosts: own } of owned) {
      const ghosts = own.length;
      const resultPath = join(workDir, `host${host}.result.json`);
      const planPath = join(workDir, `host${host}.plan.json`);
      const plan: HostGhostPlan = {
        profile: room.profile,
        namespace: room.namespace,
        seating: room.seating,
        phase: room.phase,
        gameStart: room.gameStart,
        window: room.window,
        firstPlayer: host * ghostsPerHost,
        ghosts,
        joinAt: Array.from({ length: ghosts }, () => stepStart + (joined++ * run.timing.rampMs) / ownedGhosts),
        stopAt: room.window.end,
        leaveAt: room.window.end + run.timing.drainMs,
        resultPath,
      };
      await writeFile(planPath, JSON.stringify(plan));
      resultPaths.push(resultPath);
      const log = createWriteStream(join(workDir, `host${host}.log`));
      const child = spawn(
        options.binary,
        ["signing-host", "--network", run.target.network, "--product-id", options.productId, "--auto-accept", "--script", SCRIPT],
        {
          env: {
            ...process.env,
            ...run.target.hostEnv,
            TRUAPI_HOST_NO_UPDATE: "1",
            TRUAPI_HOST_BASE_PATH: join(tmpdir(), "pop-e2e-load", run.runId, `n${count}`, `host${host}`),
            HOST_CLI_SIGNER_MNEMONIC: hostMnemonic(run.seed, host),
            GHOST_PLAN: planPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.pipe(log);
      child.stderr!.pipe(log);
      processes.push(child);
      exits.push(
        new Promise((done) => {
          child.once("error", (error) => done(`spawn: ${error.message}`));
          child.once("exit", (code, signal) => done(code === 0 ? null : signal ? `signal ${signal}` : `exit ${code}`));
        }),
      );
    }

    let atWindowStart: Map<number, { cpuSeconds: number; rssKb: number }> | undefined;
    let atWindowEnd: Map<number, { cpuSeconds: number; rssKb: number }> | undefined;
    const sample = async () => {
      const table = await readProcessTable();
      return new Map(processes.flatMap((child) => (child.pid ? [[child.pid, treeUsage(table, child.pid)] as const] : [])));
    };
    const sampling = (async () => {
      await sleepUntil(room.window.start);
      atWindowStart = await sample();
      await sleepUntil(room.window.end);
      atWindowEnd = await sample();
    })();

    const failures: Record<string, number> = {};
    return {
      stopSending() {},
      async leave() {
        const deadline = room.window.end + run.timing.drainMs + EXIT_GRACE_MS;
        const timer = setTimeout(() => processes.forEach((child) => child.kill("SIGKILL")), Math.max(0, deadline - Date.now()));
        for (const failure of await Promise.all(exits)) if (failure) bump(failures, failure);
        clearTimeout(timer);
        await sampling;
        for (const path of resultPaths) {
          const stats = await readFile(path, "utf8").then((text) => JSON.parse(text) as SignallingStats, () => undefined);
          if (stats) room.stats.add(stats);
        }
      },
      hosts(): HostUsage {
        const seconds = (room.window.end - room.window.start) / 1000;
        let cpuSeconds = 0;
        let rssKb = 0;
        for (const [pid, end] of atWindowEnd ?? []) {
          cpuSeconds += end.cpuSeconds - (atWindowStart?.get(pid)?.cpuSeconds ?? end.cpuSeconds);
          rssKb += end.rssKb;
        }
        return {
          hosts: owned.length,
          ghosts: ownedGhosts,
          failures,
          cpuPercentPerGhost: ownedGhosts > 0 ? (cpuSeconds / seconds / ownedGhosts) * 100 : 0,
          rssMbPerGhost: ownedGhosts > 0 ? rssKb / 1024 / ownedGhosts : 0,
        };
      },
    };
  };
}
