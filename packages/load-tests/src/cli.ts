import { appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runChain } from "./chain.js";
import { derivePlayers, hostGhostPlayer } from "./keys.js";
import { PHASES, PROFILES, playMs, type Phase } from "./profile.js";
import { chainMarkdown, DEFAULT_THRESHOLDS, writeSummary } from "./report.js";
import { signUpForAllowance } from "./join.js";
import { grantStatementAllowance } from "./root.js";
import { hostGhosts, PRODUCT_IDS } from "./host.js";
import { rpcGhosts, runSteps, stepMs, type StepRun } from "./signalling.js";
import { connectPeople, resolveTarget } from "./target.js";

const USAGE = `Usage: pnpm --filter @pop-e2e/load-tests load <command> [options]

Commands:
  mint        Give players 0..players-1 of --layer a statement allowance: as root, or with
              --game-at by signing them up to a load game the root key holder scheduled
  signalling  Play one game per step with that many signalling-only ghosts on direct RPC
  host        Play one game per step with signalling ghosts inside truapi-host signing hosts
  chain       Play one game on chain: schedule it as root, sign up and report with every player at once
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
  --ramp <s> --warmup <s> --drain <s> --cooldown <s>  Step phases (default 30, 10, 10, 10)
  --profile <name>      ${Object.keys(PROFILES).join(" | ")} (default jollity)
  --phase <name>        sync: every ghost opens the room at the same instant and re-sends on one
                        beat from it, as the app does (default); random: each at its own phase
  --run-id <id>         Separates topics and results of runs (default local-<time>)
  --out <dir>           Result directory (default results/<run-id>)

Host (truapi-host from TRUAPI_HOST_BIN or PATH, with bun on PATH):
  --ghosts-per-host <k> Ghosts one host process serves as its product accounts 0..k-1 (default 10)
  --product-id <id>     Product the ghosts sign as (default the app's: dim2.testnet, dim2.paseo)

Load game (live networks, where this run holds no root key):
  --game-at <s|iso>     Play time of a game the network's root key holder scheduled for the load:
                        players sign up to it, TEST_MNEMONIC paying each 3 UNIT. Never point it
                        at a real game: its players would get co-players who never connect
  --registration-wait <min>  How long to wait for that game to open registration (default 120)

Chain (phases default to the chain's own):
  --registration <s> --shuffle <s> --margin <s> --reporting <s> --player-process <s>
                        Phases of a game this run schedules as root
  --rounds <n> --group-size <n>   Game shape (default 2 and 6, as the app plays)
  --report-window <s>   Time after the game within which reports count as in time (default 35)
  --connections <n>     Clients the players' transactions are spread over (default 8)
  --take-over           Cancel a running game and remove scheduled ones before scheduling one
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
    "product-id": { type: "string" },
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

switch (values.help ? undefined : command) {
  case "mint": {
    const target = await resolveTarget(targetOptions);
    const count = positiveInteger("players", values.players);
    const indices = Array.from({ length: count }, (_, i) => i);
    const ghostsPerHost = positiveInteger("ghosts-per-host", values["ghosts-per-host"]);
    const productId = values["product-id"] ?? PRODUCT_IDS[target.network];
    const players =
      values.layer === "host"
        ? indices.map((index) => hostGhostPlayer(values.seed, productId, ghostsPerHost, index))
        : derivePlayers(values.seed, indices);
    if (gameAt !== undefined) {
      await signUpForAllowance(target, players, gameAt, positiveInteger("registration-wait", values["registration-wait"]) * 60_000);
      break;
    }
    if (!target.sudo) throw new Error(`${target.label}: no root key to write allowances; set --sudo or SUDO_URI, or pass --game-at for a scheduled load game`);
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
    const startText = values["start-at"];
    const startAt = startText === undefined ? Date.now() + 5_000 : /^\d+$/.test(startText) ? Number(startText) : Date.parse(startText);
    const run: StepRun = {
      runId: values["run-id"],
      seed: values.seed,
      steps: list([values.steps]).map((step) => positiveInteger("steps", step)),
      shard: { index: shardIndex, count: shardCount },
      startAt,
      timing: {
        rampMs: seconds("ramp", values.ramp),
        warmupMs: seconds("warmup", values.warmup),
        drainMs: seconds("drain", values.drain),
        cooldownMs: seconds("cooldown", values.cooldown),
      },
      profile,
      phase: values.phase as Phase,
      target,
      outDir,
    };
    console.log(
      `[${command}] ${target.label} via ${target.rpc.join(", ")}: steps ${run.steps.join(", ")}, ${stepMs(run) / 1000} s each, shard ${values.shard}, start ${new Date(startAt).toISOString()}`,
    );
    const players =
      command === "host"
        ? hostGhosts(run, {
            ghostsPerHost: positiveInteger("ghosts-per-host", values["ghosts-per-host"]),
            productId: values["product-id"] ?? PRODUCT_IDS[target.network],
            binary: process.env.TRUAPI_HOST_BIN ?? "truapi-host",
          })
        : rpcGhosts(run, positiveInteger("ghosts-per-connection", values["ghosts-per-connection"]));
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
      // Fresh accounts per game, also between games of one run: the sign-up uses nonce 0.
      seed: `${values.seed}/${values["run-id"]}/n${values.players}`,
      players: positiveInteger("players", values.players),
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
