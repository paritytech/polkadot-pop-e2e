import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TurnServer } from "@jollity/protocol";
import { hostGhostPlayer, hostMnemonic } from "./keys.js";
import type { Phase, SignallingProfile } from "./profile.js";
import type { HostUsage, Shard, StartPlayers, StepRun } from "./signalling.js";
import { sleepUntil } from "./time.js";
import { bump, type SignallingStats } from "./stats.js";
import type { RunIce } from "./video/run.js";
import type { VideoStats } from "./video/stats.js";

/** What one host's ghost script plays: written by the runner, read by `host-ghost.ts`. */
export interface HostGhostPlan {
  profile: SignallingProfile;
  phase: Phase;
  namespace: string;
  /** Every player's account, by player index: its id on the wire, its co-players' included. */
  accounts: string[];
  /** When the room opens, the pre-connect before the game. */
  gameStart: number;
  window: { start: number; end: number };
  /** Ghost `k` is player `firstPlayer + k`, signing as product account `firstAccount + k` of its host. */
  firstPlayer: number;
  firstAccount: number;
  ghosts: number;
  joinAt: number[];
  stopAt: number;
  leaveAt: number;
  resultPath: string;
  /** With video: the run's ICE settings, and each ghost's TURN servers. */
  video?: { ice: RunIce; turn: TurnServer[][] };
}

/** What a host's ghost script writes to `resultPath`. */
export interface HostGhostResult {
  stats: SignallingStats;
  video?: VideoStats;
}

export interface HostOptions {
  ghostsPerHost: number;
  /** The host index of player 0: lite bots are hosts from their first bot index on, one ghost each. */
  firstHost: number;
  botsPerProcess: number;
  productId: string;
  binary: string;
  /** `--stack <location>` or `--network <key>`: the stack the hosts run against. */
  stackArgs: string[];
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

/** The hosts of `count` bots that shard `shard` runs, dealt to shards in turn, and their players. */
export function shardHosts(count: number, ghostsPerHost: number, shard: Shard): Array<{ host: number; players: number[] }> {
  return Array.from({ length: Math.ceil(count / ghostsPerHost) }, (_, host) => host)
    .filter((host) => host % shard.count === shard.index)
    .map((host) => ({
      host,
      players: Array.from({ length: Math.min(ghostsPerHost, count - host * ghostsPerHost) }, (_, ghost) => host * ghostsPerHost + ghost),
    }));
}

/** The truapi-host processes of shard `shard`: each host's product accounts in runs of `botsPerProcess`. */
export function shardProcesses(
  count: number,
  ghostsPerHost: number,
  botsPerProcess: number,
  shard: Shard,
): Array<{ host: number; firstAccount: number; firstPlayer: number; ghosts: number }> {
  return shardHosts(count, ghostsPerHost, shard).flatMap(({ host, players }) =>
    Array.from({ length: Math.ceil(players.length / botsPerProcess) }, (_, processIndex) => {
      const firstAccount = processIndex * botsPerProcess;
      return { host, firstAccount, firstPlayer: players[firstAccount], ghosts: Math.min(botsPerProcess, players.length - firstAccount) };
    }),
  );
}

/**
 * Ghosts inside `truapi-host signing-host --script host-ghost.ts` processes, each signing and
 * submitting through its host as the app does. A host's `ghostsPerHost` product accounts are
 * split over processes of `botsPerProcess`, each its own client of People. Hosts, not ghosts,
 * are split over shards.
 */
export function hostGhosts(run: StepRun, options: HostOptions): StartPlayers {
  const { ghostsPerHost, firstHost } = options;
  const accounts = Array.from({ length: Math.max(...run.steps) }, (_, index) => hostGhostPlayer(run.seed, options.productId, ghostsPerHost, firstHost * ghostsPerHost + index).address);
  return async ({ count, stepStart, room }) => {
    const owned = shardProcesses(count, ghostsPerHost, options.botsPerProcess, run.shard);
    const ownedGhosts = owned.reduce((sum, { ghosts }) => sum + ghosts, 0);
    const workDir = resolve(run.outDir, "hosts", `n${count}`);
    await mkdir(workDir, { recursive: true });
    const exits: Array<Promise<string | null>> = [];
    const processes: Array<{ child: ChildProcess; ghosts: number }> = [];
    const resultPaths: string[] = [];
    let joined = 0;
    for (const { host, firstAccount, firstPlayer, ghosts } of owned) {
      const name = `host${host}-${firstAccount}`;
      const resultPath = join(workDir, `${name}.result.json`);
      const planPath = join(workDir, `${name}.plan.json`);
      const plan: HostGhostPlan = {
        profile: room.profile,
        namespace: room.namespace,
        accounts: accounts.slice(0, count),
        phase: room.phase,
        gameStart: room.gameStart,
        window: room.window,
        firstPlayer,
        firstAccount,
        ghosts,
        joinAt: Array.from({ length: ghosts }, () => stepStart + (joined++ * run.timing.rampMs) / ownedGhosts),
        stopAt: room.window.end,
        leaveAt: room.window.end + run.timing.drainMs,
        resultPath,
        ...(run.video && {
          video: {
            ice: run.video.ice,
            turn: Array.from({ length: ghosts }, (_, ghost) => run.video?.turn?.serversOf(firstPlayer + ghost) ?? []),
          },
        }),
      };
      await writeFile(planPath, JSON.stringify(plan));
      resultPaths.push(resultPath);
      const log = createWriteStream(join(workDir, `${name}.log`));
      const child = spawn(
        options.binary,
        ["signing-host", ...options.stackArgs, "--product-id", options.productId, "--auto-accept", "--script", SCRIPT],
        {
          env: {
            ...process.env,
            TRUAPI_HOST_NO_UPDATE: "1",
            TRUAPI_HOST_BASE_PATH: join(tmpdir(), "pop-e2e-load", run.runId, `n${count}`, name),
            HOST_CLI_SIGNER_MNEMONIC: hostMnemonic(run.seed, firstHost + host),
            GHOST_PLAN: planPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.pipe(log);
      child.stderr!.pipe(log);
      processes.push({ child, ghosts });
      exits.push(
        new Promise((done) => {
          child.once("error", (error) => done(`spawn: ${error.message}`));
          child.once("exit", (code, signal) => done(code === 0 ? null : signal ? `signal ${signal}` : `exit ${code}`));
        }),
      );
    }

    const sample = async () => {
      const table = await readProcessTable();
      return processes.map(({ child }) => (child.pid !== undefined && table.has(child.pid) ? treeUsage(table, child.pid) : undefined));
    };
    let atWindowStart: Array<ReturnType<typeof treeUsage> | undefined> = [];
    let atWindowEnd: Array<ReturnType<typeof treeUsage> | undefined> = [];
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
        const timer = setTimeout(() => processes.forEach(({ child }) => child.kill("SIGKILL")), Math.max(0, deadline - Date.now()));
        for (const failure of await Promise.all(exits)) if (failure) bump(failures, failure);
        clearTimeout(timer);
        await sampling;
        for (const path of resultPaths) {
          const result = await readFile(path, "utf8").then((text) => JSON.parse(text) as HostGhostResult, () => undefined);
          if (!result) continue;
          room.stats.add(result.stats);
          if (result.video) room.video?.add(result.video);
        }
      },
      hosts(): HostUsage {
        const seconds = (room.window.end - room.window.start) / 1000;
        let cpuSeconds = 0;
        let rssKb = 0;
        let ghostsInSample = 0;
        processes.forEach(({ ghosts }, index) => {
          const start = atWindowStart[index];
          const end = atWindowEnd[index];
          if (!start || !end) return;
          cpuSeconds += end.cpuSeconds - start.cpuSeconds;
          rssKb += end.rssKb;
          ghostsInSample += ghosts;
        });
        return {
          processes: processes.length,
          ghosts: ownedGhosts,
          failures,
          cpuPercentPerGhost: ghostsInSample > 0 ? (cpuSeconds / seconds / ghostsInSample) * 100 : 0,
          rssMbPerGhost: ghostsInSample > 0 ? rssKb / 1024 / ghostsInSample : 0,
        };
      },
    };
  };
}
