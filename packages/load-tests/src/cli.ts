import { appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runChain } from "./chain.js";
import { derivePlayers, hostGhostPlayer, type Player } from "./keys.js";
import { PHASES, PROFILES, playMs, type Phase } from "./profile.js";
import { ROOMS, type Rooms } from "./seating.js";
import { chainMarkdown, DEFAULT_THRESHOLDS, writeSummary } from "./report.js";
import { waitForSignUp } from "./join.js";
import { grantStatementAllowance } from "./root.js";
import { hostGhosts, PRODUCT_IDS, shardHosts } from "./host.js";
import { rpcGhosts, runSteps, stepMs, type StepRun } from "./signalling.js";
import { connectPeople, resolveTarget, type Target } from "./target.js";

const USAGE = `Usage: pnpm --filter @pop-e2e/load-tests load <command> [options]

Commands:
  mint        Write a statement allowance for players 0..players-1 of --layer as root (a fork or dev node)
  signalling  Play one game per step with that many signalling-only ghosts on direct RPC
  host        Play one game per step with signalling ghosts inside truapi-host signing hosts
  chain       Play one game on chain, signing up and reporting with every player at once: on a
              fork a game this run schedules as root, else the closest scheduled game (or --game-at)
  summary     Merge the shard results in --out into summary.json and summary.md

Target (default: the stack STACK or NETWORK selects, as for the chain-tests):
  --rpc <ws,...>        People RPC endpoints: the whole target, or with STACK in place of its People endpoint
  --network <key>       previewnet | paseo-next-v2 (descriptors; with --rpc, default previewnet)
  --sudo <uri>          Root key URI; default SUDO_URI, else //Alice on a PPN fork
  --metrics <url,...>   Prometheus endpoints of the People nodes; repeatable

Players:
  --seed <text>         Player key seed; default LOAD_SEED, else pop-e2e-load
  --players <n>         mint and chain: how many players
  --layer <name>        mint: signalling (default) or host, whose players are host product accounts

Signalling:
  --steps <n,...>       Player counts, one game each, in order (default 10,25,50)
  --shard <i/n>         This process's share of the connections (default 0/1)
  --start-at <ms|iso>   Wall-clock start of the first step, equal in every shard (default now + 5 s)
  --ghosts-per-connection <k>  Ghosts sharing one WebSocket (default 1, as on phones)
  --rpc-limit <n>       The People node's --rpc-max-connections: fail before a step that would exceed it
  --ramp <s> --warmup <s> --drain <s> --cooldown <s>  Step phases (default 30, 10, 10, 10)
  --profile <name>      ${Object.keys(PROFILES).join(" | ")} (default jollity)
  --phase <name>        sync: every ghost opens the room at the same instant and re-sends on one
                        beat from it, as the app does (default); random: each at its own phase
  --rooms <name>        co-players: each phone posts under its own topic and listens to its
                        co-players', bundles with offers deflated, as the app does since
                        individuality-apps#1972 (default); game: one room for the whole game, the app before it
  --run-id <id>         Separates topics and results of runs (default local-<time>)
  --out <dir>           Result directory (default results/<run-id>)

Host (truapi-host from TRUAPI_HOST_BIN or PATH, with bun on PATH):
  --ghosts-per-host <k> Ghosts whose keys one host mnemonic holds, as its product accounts 0..k-1 (default 10)
  --bots-per-process <k>  Ghosts one truapi-host process serves (default --ghosts-per-host); 1 makes
                        every ghost its own client of People, as a phone is, with the same keys
  --product-id <id>     Product the ghosts sign as (default the app's: dim2.testnet, dim2.paseo)
  --follow-game         Wait until the chain command has signed this run's players up to a game
                        (same --seed, network and player count), then play one step of --steps
                        with them, opening the room when the app does, 64 s before that game

Live networks (no root key): players join a scheduled game as regular players
  --game-at <s|iso>     Play time of the game to join (default: the closest scheduled one).
                        TEST_MNEMONIC tops each player up to 3 UNIT; the same players are reused
                        from game to game, so each pays its 2 UNIT play deposit once
  --registration-wait <min>  How long the run may wait for its game: to open sign-ups, and for the
                        chain layer to play (default 120); a game further away fails at once

Chain (phases default to the chain's own):
  --registration <s> --shuffle <s> --margin <s> --reporting <s> --player-process <s>
                        Phases of a game this run schedules as root
  --rounds <n> --group-size <n>   Game shape (default 2 and 6, as the app plays)
  --report-window <s>   Time after the game within which reports count as in time (default 35)
  --connections <n>     Clients the players' transactions are spread over (default 8)
  --take-over           Cancel a running game and remove scheduled ones before scheduling one
  --skip-claim          Don't claim the game's credits as NFTs on Asset Hub after the reports, as
                        every run with an Asset Hub does by default
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string", multiple: true, default: [] },
    network: { type: "string" },
    sudo: { type: "string" },
    metrics: { type: "string", multiple: true, default: [] },
    seed: { type: "string", default: process.env.LOAD_SEED ?? "pop-e2e-load" },
    players: { type: "string" },
    steps: { type: "string", default: "10,25,50" },
    shard: { type: "string", default: "0/1" },
    "start-at": { type: "string" },
    "ghosts-per-connection": { type: "string", default: "1" },
    ramp: { type: "string", default: "30" },
    warmup: { type: "string", default: "10" },
    drain: { type: "string", default: "10" },
    cooldown: { type: "string", default: "10" },
    profile: { type: "string", default: "jollity" },
    rooms: { type: "string", default: "co-players" },
    phase: { type: "string", default: "sync" },
    "run-id": { type: "string", default: `local-${Date.now()}` },
    out: { type: "string" },
    registration: { type: "string" },
    shuffle: { type: "string" },
    margin: { type: "string" },
    reporting: { type: "string" },
    "player-process": { type: "string" },
    rounds: { type: "string", default: "2" },
    "group-size": { type: "string", default: "6" },
    "report-window": { type: "string", default: "35" },
    connections: { type: "string", default: "8" },
    "take-over": { type: "boolean", default: false },
    "game-at": { type: "string" },
    "registration-wait": { type: "string", default: "120" },
    layer: { type: "string", default: "signalling" },
    "ghosts-per-host": { type: "string", default: "10" },
    "bots-per-process": { type: "string" },
    "product-id": { type: "string" },
    "rpc-limit": { type: "string" },
    "follow-game": { type: "boolean", default: false },
    "skip-claim": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

const list = (entries: string[]) => entries.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);

function positiveInteger(name: string, text: string | undefined): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer, not '${text}'`);
  return value;
}

function seconds(name: string, text: string): number {
  const value = Number(text);
  if (!(value >= 0)) throw new Error(`--${name} must be a number of seconds, not '${text}'`);
  return value * 1000;
}

/** Connections a step leaves free under `--rpc-limit`: the run's metric and chain clients, others'. */
const RPC_LIMIT_RESERVE = 10;

/** A game's play time in chain seconds, from unix seconds or an ISO date. */
function gameTime(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = /^\d+$/.test(text) ? Number(text) : Date.parse(text) / 1000;
  if (!Number.isInteger(value)) throw new Error(`--game-at must be unix seconds or an ISO date on a whole second, not '${text}'`);
  return value;
}

const command = positionals[0];
const outDir = values.out ?? `results/${values["run-id"]}`;
const targetOptions = { rpc: list(values.rpc), network: values.network, sudoUri: values.sudo ?? process.env.SUDO_URI, metrics: list(values.metrics) };
const gameAt = gameTime(values["game-at"]);
const ghostsPerHost = positiveInteger("ghosts-per-host", values["ghosts-per-host"]);
const productIdOf = (target: Target) => values["product-id"] ?? PRODUCT_IDS[target.network];

/**
 * Key seed of a game run's players. On a fork, fresh accounts per game, so the sign-up is each
 * one's first transaction. On a live network the same accounts every game, so each pays its play
 * deposit once.
 */
function gameSeed(target: Target, count: number): string {
  return target.sudo ? `${values.seed}/${values["run-id"]}/n${count}` : `${values.seed}/${target.network}`;
}

/** Players 0..count-1 of a game run, as product accounts of the truapi-hosts that send their messages. */
function gamePlayers(target: Target, count: number): Player[] {
  return Array.from({ length: count }, (_, index) => hostGhostPlayer(gameSeed(target, count), productIdOf(target), ghostsPerHost, index));
}

switch (values.help ? undefined : command) {
  case "mint": {
    const target = await resolveTarget(targetOptions);
    const count = positiveInteger("players", values.players);
    const indices = Array.from({ length: count }, (_, i) => i);
    const players =
      values.layer === "host"
        ? indices.map((index) => hostGhostPlayer(values.seed, productIdOf(target), ghostsPerHost, index))
        : derivePlayers(values.seed, indices);
    if (!target.sudo) throw new Error(`${target.label}: mint writes allowances as root; on a live network the chain command signs players up instead`);
    const { client, api } = connectPeople(target);
    try {
      // The allowance a game sign-up grants (next-people-paseo `PlayerStatementLimit`).
      await grantStatementAllowance(api, target.sudo, players, { count: 1_000_000, bytes: 1_000_000 });
    } finally {
      client.destroy();
    }
    break;
  }
  case "signalling":
  case "host": {
    const target = await resolveTarget(targetOptions);
    const profile = PROFILES[values.profile];
    if (!profile) throw new Error(`unknown --profile ${values.profile}`);
    if (!PHASES.includes(values.phase as Phase)) throw new Error(`--phase must be one of ${PHASES.join(", ")}, not '${values.phase}'`);
    const [shardIndex, shardCount] = values.shard.split("/").map(Number);
    if (!(shardIndex >= 0 && shardIndex < shardCount)) throw new Error(`--shard must be i/n with 0 <= i < n, not '${values.shard}'`);
    const steps = list([values.steps]).map((step) => positiveInteger("steps", step));
    const timing = {
      rampMs: seconds("ramp", values.ramp),
      warmupMs: seconds("warmup", values.warmup),
      drainMs: seconds("drain", values.drain),
      cooldownMs: seconds("cooldown", values.cooldown),
    };
    const ghostsPerConnection = positiveInteger("ghosts-per-connection", values["ghosts-per-connection"]);
    const productId = productIdOf(target);
    // On a live network only the bots the chain command signed up hold a statement allowance.
    const seed = values["follow-game"] || !target.sudo ? gameSeed(target, steps[0]) : values.seed;
    const startText = values["start-at"];
    let startAt = startText === undefined ? Date.now() + 5_000 : /^\d+$/.test(startText) ? Number(startText) : Date.parse(startText);
    if (!ROOMS.includes(values.rooms as Rooms)) throw new Error(`--rooms must be one of ${ROOMS.join(", ")}, not '${values.rooms}'`);
    if (values["follow-game"]) {
      if (command !== "host" || steps.length !== 1) throw new Error("--follow-game plays one step of host, as in `host --steps <players>`");
      const own = shardHosts(steps[0], ghostsPerHost, { index: shardIndex, count: shardCount }).flatMap(({ ghosts }) => ghosts);
      if (own.length === 0) throw new Error(`machine ${shardIndex} has no bots: ${steps[0]} bots fill fewer hosts of ${ghostsPerHost} than ${shardCount} machines`);
      const watched = own.slice(0, 50).map((index) => hostGhostPlayer(seed, productId, ghostsPerHost, index));
      console.log(`[host] waiting for this machine's ${own.length} bots to be signed up to a game`);
      const game = await waitForSignUp(target, watched, positiveInteger("registration-wait", values["registration-wait"]) * 60_000);
      startAt = game.game_date * 1000 - profile.preconnectMs - timing.rampMs - timing.warmupMs;
      console.log(`[host] game ${game.index} plays at ${new Date(game.game_date * 1000).toISOString()}`);
    }
    const run: StepRun = {
      runId: values["run-id"],
      seed,
      steps,
      shard: { index: shardIndex, count: shardCount },
      startAt,
      timing,
      profile,
      phase: values.phase as Phase,
      rooms: values.rooms as Rooms,
      target,
      outDir,
    };
    console.log(
      `[${command}] ${target.label} via ${target.rpc.join(", ")}: steps ${run.steps.join(", ")}, ${stepMs(run) / 1000} s each, shard ${values.shard}, start ${new Date(startAt).toISOString()}`,
    );
    if (values["rpc-limit"] !== undefined) {
      // A host opens a People connection per subscription, plus its own; ghosts on direct RPC
      // share theirs. A step over the limit measures the limit, not the node.
      const limit = positiveInteger("rpc-limit", values["rpc-limit"]);
      const largest = Math.max(...run.steps);
      const connections = command === "host" ? largest + Math.ceil(largest / ghostsPerHost) : Math.ceil(largest / ghostsPerConnection);
      const perNode = Math.ceil(connections / target.rpc.length);
      if (perNode > limit - RPC_LIMIT_RESERVE) {
        throw new Error(
          `a step of ${largest} players needs ${perNode} connections per People node, over its limit of ${limit} less ${RPC_LIMIT_RESERVE} for the run's own clients; raise --ghosts-per-connection or the node's --rpc-max-connections`,
        );
      }
    }
    const players =
      command === "host"
        ? hostGhosts(run, {
            ghostsPerHost,
            botsPerProcess: positiveInteger("bots-per-process", values["bots-per-process"] ?? String(ghostsPerHost)),
            productId,
            binary: process.env.TRUAPI_HOST_BIN ?? "truapi-host",
          })
        : rpcGhosts(run, ghostsPerConnection);
    await runSteps(run, command === "host" ? "host" : "signalling", players);
    if (shardCount === 1) console.log(await writeSummary(outDir, DEFAULT_THRESHOLDS));
    break;
  }
  case "chain": {
    const target = await resolveTarget(targetOptions);
    const overrides = { registration: values.registration, shuffle: values.shuffle, post_shuffle_margin: values.margin, reporting: values.reporting, player_process: values["player-process"] };
    const phases = Object.fromEntries(
      Object.entries(overrides).flatMap(([phase, text]) => (text === undefined ? [] : [[phase, seconds(phase, text) / 1000]])),
    );
    const result = await runChain({
      runId: values["run-id"],
      players: gamePlayers(target, positiveInteger("players", values.players)),
      target,
      outDir,
      phases,
      rounds: positiveInteger("rounds", values.rounds),
      maxGroupSize: positiveInteger("group-size", values["group-size"]),
      playMs: playMs(PROFILES[values.profile]),
      reportWindowMs: seconds("report-window", values["report-window"]),
      connections: positiveInteger("connections", values.connections),
      takeOver: values["take-over"],
      gameAt,
      registrationWaitMs: positiveInteger("registration-wait", values["registration-wait"]) * 60_000,
      claim: target.assetHubRpc !== undefined && !values["skip-claim"],
    });
    const text = chainMarkdown(result);
    await writeFile(`${outDir}/chain.n${result.players}.md`, text);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    break;
  }
  case "summary": {
    const text = await writeSummary(outDir, DEFAULT_THRESHOLDS);
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(command && !values.help ? 1 : 0);
}
process.exit(0);
