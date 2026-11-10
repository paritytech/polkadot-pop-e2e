import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Enum, type SizedHex } from "polkadot-api";
import { toHex } from "@polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { submitBurst, summarizeBurst, type BurstSummary } from "./burst.js";
import { derivePlayers, type Player } from "./keys.js";
import { dispatchAsRoot, fundPlayers } from "./root.js";
import { RpcConnection } from "./rpc.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";

export interface Phases {
  registration: number;
  shuffle: number;
  post_shuffle_margin: number;
  reporting: number;
  player_process: number;
}

export interface ChainRun {
  runId: string;
  seed: string;
  players: number;
  target: Target;
  outDir: string;
  /** Seconds overriding the chain's phase durations for this game. */
  phases: Partial<Phases>;
  rounds: number;
  maxGroupSize: number;
  /** Time from the game date to the players' reports: the game's length. */
  playMs: number;
  /** Time after the game within which a player's report has to be in a block. */
  reportWindowMs: number;
  /** RPC connections the players' transactions are spread over. */
  connections: number;
  /** Cancels a running game and removes scheduled ones instead of failing on them. */
  takeOver: boolean;
}

export interface BlockLoad {
  number: number;
  extrinsics: number;
  /** Normal-class weight used over the normal-class limit. */
  refTime: number;
  proofSize: number;
}

export interface ChainResult {
  layer: "chain";
  runId: string;
  players: number;
  target: string;
  verdict: "pass" | "fail";
  findings: string[];
  phases: Phases;
  game: { index: number; gamePlayTime: number; registrationEnds: number; reportEnds: number };
  /** Every game state and step seen, with the wall-clock time it was first seen. */
  timeline: Array<{ state: string; at: number }>;
  signUp: BurstSummary;
  report: BurstSummary | null;
  blocks: BlockLoad[];
}

/** Free balance per player: the default 2 UNIT play deposit, existential deposit and fees. */
const PLAYER_FUNDS = 30_000_000_000n;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stateLabel(game: { state: { type: string; value?: unknown } } | undefined): string {
  if (!game) return "None";
  const step = (game.state.value as { step?: { type: string } } | undefined)?.step;
  return step ? `${game.state.type}.${step.type}` : game.state.type;
}

/** A deterministic stand-in for the player's P-256 communication key, which the chain only stores. */
function identifierKey(player: Player): SizedHex<65> {
  const seed = blake2b256(player.publicKey);
  return toHex(new Uint8Array([4, ...seed, ...blake2b256(seed)])) as SizedHex<65>;
}

/**
 * Each player's report: one `Person` vote per other member of its group in each round, the
 * groups following from the shuffled indices as the pallet forms them.
 */
async function buildReports(api: PeopleApi, players: Player[], playerCount: number, maxGroupSize: number, rounds: number) {
  const groups = Math.ceil(playerCount / maxGroupSize);
  const indices = await api.query.Game.PlayerToIndex.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" });
  return players.flatMap((player, position) => {
    const own = indices[position];
    if (!own) return [];
    const fullReport = own.slice(0, rounds).map((index) =>
      Array.from({ length: maxGroupSize }, (_, member) => (index % groups) + member * groups)
        .filter((member) => member < playerCount && member !== index)
        .map(() => Enum("Person")),
    );
    return [{ player, fullReport }];
  });
}

/**
 * Plays one game with `players` funded accounts: sudo schedules it, every player signs up at
 * once, the chain shuffles, and every player reports at once after the game's length. Every
 * deadline is the chain's clock, which a dev node runs at its own pace.
 */
export async function runChain(run: ChainRun): Promise<ChainResult> {
  const { target } = run;
  if (!target.sudo) throw new Error(`${target.label}: no root key; set --sudo or SUDO_URI`);
  const sudo = target.sudo;
  const { client, api } = connectPeople(target);
  const connections = await Promise.all(
    Array.from({ length: run.connections }, (_, i) => RpcConnection.open(target.rpc[i % target.rpc.length], 15_000)),
  );
  const timeline: ChainResult["timeline"] = [];
  const blocks: BlockLoad[] = [];
  const findings: string[] = [];
  const chainNow = async () => Number(await api.query.Timestamp.Now.getValue({ at: "best" }));
  let previousPhases: Phases | undefined;
  let watching = true;

  try {
    const existing = await api.query.Game.Game.getValue();
    const schedules = await api.query.Game.GameSchedules.getValue();
    if (existing || schedules.length > 0) {
      if (!run.takeOver) {
        throw new Error(`${target.label} has a game ${existing ? "running" : "scheduled"}; pass --take-over to cancel it`);
      }
      const calls = [
        ...(existing ? [api.tx.Game.cancel_game().decodedCall] : []),
        ...schedules.map((schedule) => api.tx.Game.remove_scheduled_game({ game_play_time: schedule.game_play_time }).decodedCall),
      ];
      await dispatchAsRoot(api, sudo, calls, calls.length, "take-over");
      while (await api.query.Game.Game.getValue({ at: "best" })) await sleep(2_000);
    }

    const players = derivePlayers(run.seed, Array.from({ length: run.players }, (_, i) => i));
    await fundPlayers(api, sudo, players, PLAYER_FUNDS);

    const chainPhases = (await api.query.Game.StoredPhaseDurations.getValue()) ?? (await api.constants.Game.DefaultPhaseDurations());
    const phases: Phases = { ...chainPhases, ...run.phases };
    if (Object.keys(run.phases).length > 0) previousPhases = chainPhases;
    // Slack of a few blocks: the chain starts the game only before its registration start.
    const gamePlayTime = Math.ceil((await chainNow()) / 1000) + phases.registration + phases.shuffle + phases.post_shuffle_margin + 30;
    const schedule = api.tx.Game.schedule_games({
      games_schedules: [{ game_play_time: gamePlayTime, rounds: run.rounds, max_group_size: run.maxGroupSize, airdrops: [] }],
    });
    await dispatchAsRoot(api, sudo, [api.tx.Game.set_game_phases({ phases }).decodedCall, schedule.decodedCall], 2, "schedule");

    const maxNormal = (await api.constants.System.BlockWeights()).per_class.normal.max_total!;
    const blockSubscription = client.finalizedBlock$.subscribe(async (block) => {
      const [weight, body] = await Promise.all([api.query.System.BlockWeight.getValue({ at: block.hash }), client.getBlockBody(block.hash)]);
      blocks.push({
        number: block.number,
        extrinsics: body.length,
        refTime: Number(weight.normal.ref_time) / Number(maxNormal.ref_time),
        proofSize: Number(weight.normal.proof_size) / Number(maxNormal.proof_size),
      });
    });
    void (async () => {
      while (watching) {
        const label = stateLabel(await api.query.Game.Game.getValue({ at: "best" }).catch(() => undefined));
        if (timeline.at(-1)?.state !== label) {
          timeline.push({ state: label, at: Date.now() });
          console.log(`[chain] game: ${label}`);
        }
        await sleep(1_000);
      }
    })();
    const waitFor = async (accept: (state: string) => boolean, timeoutMs: number, what: string) => {
      const until = Date.now() + timeoutMs;
      while (!accept(timeline.at(-1)?.state ?? "")) {
        if (Date.now() > until) throw new Error(`no ${what} within ${timeoutMs / 1000} s; game ${timeline.at(-1)?.state}`);
        await sleep(500);
      }
    };

    await waitFor((state) => state === "Registration", 120_000, "Registration");
    const game = (await api.query.Game.Game.getValue({ at: "best" }))!;
    console.log(`[chain] game ${game.index}: ${run.players} players sign up`);
    // Fresh accounts: the sign-up is each player's first transaction, the report its second.
    const signUp = await submitBurst(
      players.map((player) => ({
        signer: player,
        tx: api.tx.Game.sign_up_with_account({ identifier_key: identifierKey(player), airdrops: undefined }),
        nonce: 0,
      })),
      api,
      client,
      connections,
      () => game.registration_ends * 1000,
    );
    console.log(`[chain] sign-ups: ${signUp.ok}/${signUp.submitted} in ${signUp.durationMs} ms`);
    if (signUp.inTime < run.players) findings.push(`sign-up: ${run.players - signUp.inTime} of ${run.players} not in before registration ended`);

    await waitFor((state) => state.startsWith("Reporting") || state === "None" || state.startsWith("Cancelling"), 3_600_000, "Reporting");
    const reached = timeline.at(-1)!.state;
    let report: BurstSummary | null = null;
    if (!reached.startsWith("Reporting")) {
      findings.push(`shuffle: the game went to ${reached} instead of Reporting`);
    } else {
      // Players report once the last turn is over.
      while ((await chainNow()) < game.game_date * 1000 + run.playMs) await sleep(1_000);
      const current = (await api.query.Game.Game.getValue({ at: "best" }))!;
      if (current.state.type !== "Reporting") throw new Error(`game left Reporting before the reports: ${stateLabel(current)}`);
      const reports = await buildReports(api, players, current.state.value.player_count, current.max_group_size, current.rounds);
      console.log(`[chain] ${reports.length} players report`);
      const burst = await submitBurst(
        reports.map(({ player, fullReport }) => ({ signer: player, tx: api.tx.Game.report({ full_report: fullReport }), nonce: 1 })),
        api,
        client,
        connections,
        (chainStart) => Math.min(chainStart + run.reportWindowMs, current.report_ends * 1000),
      );
      report = summarizeBurst(burst);
      console.log(`[chain] reports: ${burst.ok}/${burst.submitted}, ${burst.inTime} within ${run.reportWindowMs / 1000} s`);
      if (burst.inTime < reports.length) {
        findings.push(`report: ${reports.length - burst.inTime} of ${reports.length} not in within ${run.reportWindowMs / 1000} s`);
      }
      const remainingMs = (current.report_ends + phases.player_process) * 1000 - (await chainNow());
      await waitFor((state) => state === "None" || state.startsWith("Cancelling"), Math.max(0, remainingMs) + 600_000, "game end");
      if (timeline.at(-1)!.state !== "None") findings.push(`player processing: the game went to ${timeline.at(-1)!.state}`);
    }
    for (const [failure, count] of Object.entries(signUp.failures)) findings.push(`sign-up ${failure}: ${count}`);
    for (const [failure, count] of Object.entries(report?.failures ?? {})) findings.push(`report ${failure}: ${count}`);
    blockSubscription.unsubscribe();

    const result: ChainResult = {
      layer: "chain",
      runId: run.runId,
      players: run.players,
      target: target.label,
      verdict: findings.length === 0 ? "pass" : "fail",
      findings,
      phases,
      game: { index: game.index, gamePlayTime: game.game_date, registrationEnds: game.registration_ends, reportEnds: game.report_ends },
      timeline,
      signUp: summarizeBurst(signUp),
      report,
      blocks: blocks.sort((a, b) => a.number - b.number),
    };
    await mkdir(run.outDir, { recursive: true });
    await writeFile(join(run.outDir, `chain.n${run.players}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    watching = false;
    // The phases apply to every later game, so a run on a shared network sets them back.
    if (previousPhases) {
      await dispatchAsRoot(api, sudo, [api.tx.Game.set_game_phases({ phases: previousPhases }).decodedCall], 1, "restore phases").catch(
        (error: Error) => console.warn(`[chain] phases not restored: ${error.message}`),
      );
    }
    for (const connection of connections) connection.close();
    client.destroy();
  }
}
