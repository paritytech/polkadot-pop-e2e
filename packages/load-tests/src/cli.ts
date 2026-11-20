import { appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runChain } from "./chain.js";
import { readChainSeats } from "./chain-seats.js";
import { derivePlayers, hostGhostPlayer, type Player } from "./keys.js";
import { deriveLiteBot, LITE_FIRST_INDEX, provisionLitePeople, type LiteBot } from "./lite.js";
import { PHASES, PROFILES, playMs, type Phase } from "./profile.js";
import { chainMarkdown, DEFAULT_THRESHOLDS, writeSummary } from "./report.js";
import { waitForSignUp } from "./join.js";
import { grantStatementAllowance } from "./root.js";
import { hostGhosts, shardHosts, shardProcesses, type HostOptions } from "./host.js";
import { rpcGhosts, runSteps, stepMs, type StepRun } from "./signalling.js";
import { connectPeople, gameProductId, networkTld, resolveTarget, type Target } from "./target.js";
import { APP_STUN_URLS } from "./video/ice.js";
import type { VideoRun } from "./video/run.js";
import { openLiteTurnPasses } from "./video/turn.js";

const USAGE = `Usage: pnpm --filter @pop-e2e/load-tests load <command> [options]

Commands:
  mint        Write a statement allowance for players 0..players-1 of --layer as root (a fork or dev node)
  people      Make lite bots --lite-from.. of --players lite people as phones become one, with
              truapi-host attest through the stack's identity backend (DUB); bots that are lite people already are skipped
  signalling  Play one game per step with that many signalling-only ghosts on direct RPC
  host        Play one game per step with signalling ghosts inside truapi-host signing hosts
  chain       Play one game on chain, signing up and reporting with every player at once: on a
              fork a game this run schedules as root, else the closest scheduled game (or --game-at)
  summary     Merge the shard results in --out into summary.json and summary.md

Target (default: the stack STACK or NETWORK selects, as for the chain-tests):
  --rpc <ws,...>        People RPC endpoints: the whole target, or with STACK in place of its People endpoint;
                        not for host, whose truapi-host and ghosts connect through the stack
  --network <key>       previewnet | paseo-next-v2 (descriptors; with --rpc, default previewnet)
  --sudo <uri>          Root key URI; default SUDO_URI, else //Alice on a PPN fork
  --metrics <url,...>   Prometheus endpoints of the People nodes; repeatable

Players:
  --seed <text>         Player key seed; default LOAD_SEED, else pop-e2e-load, the seed the live
                        networks' funded bots derive from
  --players <n>         mint, people and chain: how many players
  --layer <name>        mint: signalling (default) or host, whose players are host product accounts

Lite bots (lite people, signing up free as a lite person's phone does):
  --lite-from <index>   First bot index of the lite bots (default ${LITE_FIRST_INDEX}), above the
                        deposit-backed bots. A lite bot's keys follow from --seed, the network and its
                        index alone, so a later run with the same seed and range finds the same lite people
  --attest-concurrency <n>  people: attests running at once (default 3); DUB registers about 4.5
                        names a minute, and truapi-host waits 2 min for a name, so more fail

Signalling:
  --steps <n,...>       Player counts, one game each, in order (default 10,25,50)
  --shard <i/n>         This process's share of the connections (default 0/1)
  --start-at <ms|iso>   Wall-clock start of the first step, equal in every shard (default now + 5 s)
  --ghosts-per-connection <k>  Ghosts sharing one WebSocket (default 1, as on phones)
  --rpc-limit <n>       The People node's --rpc-max-connections: fail before a step that would exceed it
  --ramp <s> --warmup <s> --drain <s> --cooldown <s>  Step phases (default 30, 10, 10, 10)
  --profile <name>      ${Object.keys(PROFILES).join(" | ")} (default jollity)
  --phase <name>        sync: every ghost opens the room at the same instant, as the app does
                        (default); random: each up to one heartbeat later
  --run-id <id>         Separates topics and results of runs (default local-<time>)
  --out <dir>           Result directory (default results/<run-id>)
  --video               Real WebRTC peer connections (werift) in place of descriptions of Chrome's size:
                        each link negotiated as the app's mesh does, H.264 360x360 at 24 fps to the
                        current round's group, the next round's co-players on standby
  --relay               With --video: only relay candidates, through the lite bots' TURN servers
  --stun <url,...>      With --video: STUN servers (default the app's six); empty for none
  --turn-issuer <url>   With --video --lite: the TURN credential issuer (default the stack's identity backend)
  --ice-address <ip>    With --video: gather host candidates on this address alone, such as 127.0.0.1
                        when every bot runs on one machine

Host (truapi-host from TRUAPI_HOST_BIN or PATH, with bun on PATH):
  --ghosts-per-host <k> Ghosts whose keys derive from one host mnemonic, as its product accounts 0..k-1 (default 10)
  --bots-per-process <k>  Ghosts one truapi-host process serves (default --ghosts-per-host); 1 makes
                        every ghost its own client of People, as a phone is, with the same keys
  --product-id <id>     Product the ghosts sign as (default the app's: dim2.testnet, dim2.paseo)
  --follow-game         Wait until the chain command has signed this run's players up to a game
                        (same --seed, network and player count), then play one step of --steps
                        with them, opening the room when the app does, 64 s before that game
  --lite                The players are lite bots --lite-from.., one host each, as \`chain --lite\` signs
                        them up; with --video each fetches TURN credentials when the app does: once its
                        game is known, then 10 and 3 minutes before it

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
  --lite                The players are lite bots: bound to their lite person before the game, they
                        sign up free with Game.sign_up_with_account_lite_invite and get no funds
  --draw                Players enter the game's prize draws as the app enters them, so a player the game
                        can't make a member yet signs up without a ticket. Winners claim their prize. A
                        game this run schedules gets one draw
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
    "bots-per-process": { type: "string" },
    "product-id": { type: "string" },
    "rpc-limit": { type: "string" },
    "follow-game": { type: "boolean", default: false },
    "skip-claim": { type: "boolean", default: false },
    lite: { type: "boolean", default: false },
    draw: { type: "boolean", default: false },
    "lite-from": { type: "string", default: String(LITE_FIRST_INDEX) },
    "attest-concurrency": { type: "string", default: "3" },
    help: { type: "boolean", short: "h" },
    video: { type: "boolean", default: false },
    relay: { type: "boolean", default: false },
    stun: { type: "string" },
    "turn-issuer": { type: "string" },
    "ice-address": { type: "string" },
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
const productIdOf = (target: Target) => values["product-id"] ?? gameProductId(target.network);

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

/**
 * Where the network's lite bots come from: host `from + i` of `seed`, one ghost each. Lite bots are
 * the same on every run, since a lite person stays one.
 */
function liteRange(target: Target): { seed: string; from: number } {
  return { seed: `${values.seed}/${target.network}`, from: positiveInteger("lite-from", values["lite-from"]) };
}

/** Lite bots `--lite-from + offset` of the network, for each of `offsets`: the chain layer's, the host layer's and their TURN passes'. */
function deriveLiteBots(target: Target, offsets: number[]): LiteBot[] {
  const { seed, from } = liteRange(target);
  return offsets.map((offset) => deriveLiteBot(seed, productIdOf(target), networkTld(target.network), from + offset));
}

const firstOffsets = (count: number) => Array.from({ length: count }, (_, offset) => offset);

switch (values.help ? undefined : command) {
  case "people": {
    // truapi-host connects to DUB and People through STACK or NETWORK alone, never `--rpc`.
    if (targetOptions.rpc.length > 0 && !process.env.STACK) {
      throw new Error("people attests through the stack's identity backend: set STACK to the stack's descriptor, with --rpc only in place of its People endpoint");
    }
    const target = await resolveTarget(targetOptions);
    const bots = deriveLiteBots(target, firstOffsets(positiveInteger("players", values.players)));
    console.log(`[people] ${target.label}: lite bots ${bots[0].player.index}..${bots.at(-1)!.player.index} of seed ${values.seed}`);
    const result = await provisionLitePeople(target, bots, {
      concurrency: positiveInteger("attest-concurrency", values["attest-concurrency"]),
      inclusionTimeoutMs: 20 * 60_000,
    });
    const { p50, p95, max } = result.attestMs;
    console.log(
      [
        `### Lite people on ${target.label}`,
        "",
        `- ${bots.length} lite bots, ${bots[0].player.index}..${bots.at(-1)!.player.index}: ${result.alreadyLite} lite people already, ${result.attestCount} attested now, ${result.pending} pending at DUB, failures ${JSON.stringify(result.failures)}`,
        `- attest p50 / p95 / max: ${[p50, p95, max].map((ms) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`)).join(" / ")}, ${values["attest-concurrency"]} at a time`,
        `- ${result.inRing} of ${bots.length} in a lite ring root after ${(result.durationMs / 1000).toFixed(1)} s`,
      ].join("\n"),
    );
    if (result.inRing < bots.length) throw new Error(`${bots.length - result.inRing} of ${bots.length} lite bots are in no ring root`);
    break;
  }
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
    if (command === "host" && targetOptions.rpc.length > 0) {
      throw new Error("host doesn't take --rpc: truapi-host and the ghosts inside it connect through the stack STACK or NETWORK selects");
    }
    const target = await resolveTarget(targetOptions);
    // Without --rpc, resolveTarget has loaded the stack; this reads the same STACK or NETWORK.
    const stackArgs = command === "host" ? (await import("@pop-e2e/chain-tests/src/config/networks.js")).truapiHostStackArgs() : [];
    if (stackArgs[0] === "--stack" && process.env.TRUAPI_CHAIN_BACKEND === "light-client") {
      throw new Error("truapi-host runs on a light client only on a built-in network: unset STACK or TRUAPI_CHAIN_BACKEND");
    }
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
    if (values.lite && command !== "host") throw new Error("--lite plays lite bots in the host layer only: `host --lite`");
    if (values.relay && !(values.video && values.lite)) throw new Error("--relay sends media through TURN servers, which only lite bots get: `host --video --lite --relay`");
    // A lite bot is the only product account of its own host, from host `--lite-from` on.
    const lite = values.lite ? liteRange(target) : undefined;
    const layout = lite ? { ghostsPerHost: 1, firstHost: lite.from } : { ghostsPerHost, firstHost: 0 };
    // On a live network only the host bots the chain command signed up have a statement allowance.
    const seed = lite ? lite.seed : values["follow-game"] || (command === "host" && !target.sudo) ? gameSeed(target, steps[0]) : values.seed;
    const startText = values["start-at"];
    let startAt = startText === undefined ? Date.now() + 5_000 : /^\d+$/.test(startText) ? Number(startText) : Date.parse(startText);
    if (Number.isNaN(startAt)) throw new Error(`--start-at must be ms or an ISO time, not '${startText}'`);
    let chainGame: HostOptions["game"];
    if (values["follow-game"]) {
      if (command !== "host" || steps.length !== 1) throw new Error("--follow-game plays one step of host, as in `host --steps <players>`");
      const own = shardHosts(steps[0], layout.ghostsPerHost, { index: shardIndex, count: shardCount }).flatMap(({ players }) => players);
      if (own.length === 0) throw new Error(`machine ${shardIndex} has no bots: ${steps[0]} bots fill fewer hosts of ${layout.ghostsPerHost} than ${shardCount} machines`);
      const watched = own.slice(0, 50).map((index) => hostGhostPlayer(seed, productId, layout.ghostsPerHost, layout.firstHost * layout.ghostsPerHost + index));
      console.log(`[host] waiting for this machine's ${own.length} bots to be signed up to a game`);
      const game = await waitForSignUp(target, watched, positiveInteger("registration-wait", values["registration-wait"]) * 60_000);
      startAt = game.game_date * 1000 - profile.preconnectMs - timing.rampMs - timing.warmupMs;
      console.log(`[host] game ${game.index} plays at ${new Date(game.game_date * 1000).toISOString()}`);
      chainGame = {
        index: game.index,
        async readSeats(bots) {
          const { client, engine } = connectPeople(target);
          try {
            return await readChainSeats(engine, game.index, bots, game.game_date * 1000 + 60_000);
          } finally {
            client.destroy();
          }
        },
      };
    }
    let video: VideoRun | undefined;
    let closeTurn = () => {};
    if (values.video) {
      video = { ice: { stunUrls: values.stun === undefined ? APP_STUN_URLS : list([values.stun]), relay: values.relay, interfaceAddress: values["ice-address"] } };
      if (values.lite) {
        // Loaded on use, as for stackArgs above: the module reads STACK or NETWORK when it loads.
        const config = (await import("@pop-e2e/chain-tests/src/config/networks.js")).getNetworkConfig();
        const issuer = values["turn-issuer"] ?? config.identityBackend;
        if (!issuer) throw new Error(`${target.label} has no identity backend to issue TURN credentials: pass --turn-issuer`);
        const own = shardHosts(Math.max(...steps), 1, { index: shardIndex, count: shardCount }).flatMap(({ players }) => players);
        const liteEntropies = new Map(deriveLiteBots(target, own).map(({ player }, position) => [own[position], player.liteEntropy]));
        const turn = await openLiteTurnPasses(target, liteEntropies, productId, issuer);
        video.turn = turn.passes;
        closeTurn = turn.close;
        // The app fetches as soon as it knows of its game: the first step's game, after the pre-connect.
        await turn.passes.warm(startAt + timing.rampMs + timing.warmupMs + profile.preconnectMs);
        const withTurn = own.filter((index) => turn.passes.serversOf(index).length > 0).length;
        console.log(`[${command}] TURN credentials from ${issuer}: ${withTurn} of ${own.length} lite bots`);
      }
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
      target,
      outDir,
      video,
    };
    // A machine that boots late still plays the rest of the step and reports how late it was.
    if (startAt + stepMs(run) < Date.now()) throw new Error(`--start-at ${new Date(startAt).toISOString()}: the first step is already over`);
    console.log(
      `[${command}] ${target.label} via ${target.rpc.join(", ")}: steps ${run.steps.join(", ")}, ${stepMs(run) / 1000} s each, shard ${values.shard}, start ${new Date(startAt).toISOString()}`,
    );
    const botsPerProcess = positiveInteger("bots-per-process", values["bots-per-process"] ?? String(layout.ghostsPerHost));
    if (values["rpc-limit"] !== undefined) {
      // A truapi-host process opens a People connection per subscription, plus its own, all to the
      // stack's People endpoint; ghosts on direct RPC share theirs over `--rpc`. A step over the
      // limit measures the limit, not the node.
      const limit = positiveInteger("rpc-limit", values["rpc-limit"]);
      const largest = Math.max(...run.steps);
      const [connections, nodes, remedy] =
        command === "host"
          ? [largest + shardProcesses(largest, layout.ghostsPerHost, botsPerProcess, { index: 0, count: 1 }).length, 1, "play fewer players"]
          : [Math.ceil(largest / ghostsPerConnection), target.rpc.length, "raise --ghosts-per-connection"];
      const perNode = Math.ceil(connections / nodes);
      if (perNode > limit - RPC_LIMIT_RESERVE) {
        throw new Error(
          `a step of ${largest} players needs ${perNode} connections per People node, over its limit of ${limit} less ${RPC_LIMIT_RESERVE} for the run's own clients; ${remedy} or raise the node's --rpc-max-connections`,
        );
      }
    }
    const players =
      command === "host"
        ? hostGhosts(run, {
            ghostsPerHost: layout.ghostsPerHost,
            firstHost: layout.firstHost,
            botsPerProcess,
            productId,
            binary: process.env.TRUAPI_HOST_BIN ?? "truapi-host",
            stackArgs,
            game: chainGame,
          })
        : rpcGhosts(run, ghostsPerConnection);
    await runSteps(run, command === "host" ? "host" : "signalling", players);
    closeTurn();
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
      players: values.lite ? deriveLiteBots(target, firstOffsets(positiveInteger("players", values.players))).map(({ player }) => player) : gamePlayers(target, positiveInteger("players", values.players)),
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
      draw: values.draw,
    }).catch(async (error: Error) => {
      // A run that stops before its result, such as on a game it can't make, still says why on the run's page.
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Chain game on ${target.label}: fail\n\n- ${error.message}\n`);
      throw error;
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
