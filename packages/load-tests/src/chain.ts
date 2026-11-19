import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromPapi, groupSeats, reportTx, type ReportVote } from "@parity/product-sdk-individuality";
import { statePlayerCount, type GameEngine, type PalletGame } from "@jollity/protocol/src/engine";
import { followBlockLoad, stateLabel, type BlockFollower, type BlockLoad } from "./block-load.js";
import { submitBurst, summarizeBurst, type BurstSummary } from "./burst.js";
import { readProposals, type Proposal } from "./collator-log.js";
import { claimCredits, type ClaimResult } from "./claim.js";
import { buildDraw, GAME_AIRDROP_SOURCE, settleDraw, type DrawResult } from "./draw.js";
import { ALREADY_REGISTERED, bindLiteBots, SIGN_UP_MS, signSignUps, topUpPlayers, waitForGame, PLAYER_FUNDS } from "./join.js";
import type { Keypair, Player } from "./keys.js";
import { readRootKey } from "./lite.js";
import { dispatchAsRoot, fundPlayers } from "./root.js";
import { findBlockLimits, splitStates } from "./phases.js";
import { SigningPool } from "./signing-pool.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { readAll, sleep } from "./time.js";

/** How long the run waits after the game for its last blocks to be finalized and read. */
const FINALIZED_WAIT_MS = 120_000;

export interface Phases {
  registration: number;
  shuffle: number;
  post_shuffle_margin: number;
  reporting: number;
  player_process: number;
}

export interface ChainRun {
  runId: string;
  /** The accounts that play, the same ones a run's message bots sign with. */
  players: Player[];
  target: Target;
  outDir: string;
  /**
   * With a root key (a fork), this run schedules its own game, after clearing the chain when
   * `takeOver`. Without one (a live network), the players join a scheduled game like any
   * player: the one playing at `gameAt` (chain seconds), or else the closest.
   */
  gameAt: number | undefined;
  /** Seconds overriding the chain's phase durations for an own game. */
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
  /** How long a joining run waits for its game to open registration. */
  registrationWaitMs: number;
  /** Claims the credits the game awarded as NFTs on Asset Hub once they arrive there. */
  claim: boolean;
  /** The players are lite bots, which sign up free after a bind and get no funds. */
  lite: boolean;
  /** The own game holds one prize draw, which every player enters and the winners claim. Takes the chain's root key. */
  draw: boolean;
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
  /** Claiming the game's credits as NFTs on Asset Hub, when the run claims. */
  claim: ClaimResult | null;
  /** Every finalized People block from the run's start to its end. */
  blocks: BlockLoad[];
  /** Collator 1's proposals in the game's blocks, from previewnet's public log; null elsewhere or when the log wasn't read. */
  proposals: Proposal[] | null;
  /** What the run couldn't read, without failing it. */
  notes: string[];
  /** Where People blocks came close to their limits without failing the run. */
  capacity: string[];
  /** Lite bots' binds by outcome, and how many hold a deposit after signing up; null for deposit-backed bots. */
  lite: { binds: Record<string, number>; withDeposit: number } | null;
  /** The prize draw's tickets, winners and claims; null without `draw`. */
  draw: DrawResult | null;
}

/** As root: clears the chain's game and schedule when `takeOver`, then funds the players. */
async function clearAndFund(api: PeopleApi, run: ChainRun, sudo: Keypair, players: Player[]): Promise<void> {
  const { target } = run;
  const existing = await api.query.Game.Game.getValue();
  const schedules = await api.query.Game.GameSchedules.getValue();
  if (existing || schedules.length > 0) {
    if (!run.takeOver) {
      throw new Error(`${target.label} has a game ${existing ? "running" : "scheduled"}; pass --take-over to cancel it, or --game-at to play a load game`);
    }
    // The schedules go first, so no copied game starts once the current one ends. Only a game in
    // registration or the shuffle can be cancelled; reporting can be ended at once on a testnet;
    // player processing and cancelling finish by themselves within a few blocks.
    const endCurrent =
      existing?.state.type === "Registration" || existing?.state.type === "Shuffle"
        ? [api.tx.Game.cancel_game().decodedCall]
        : existing?.state.type === "Reporting"
          ? [api.tx.Game.testnet_force_end_reporting().decodedCall]
          : [];
    const calls = [
      ...schedules.map((schedule) => api.tx.Game.remove_scheduled_game({ game_play_time: schedule.game_play_time }).decodedCall),
      ...endCurrent,
    ];
    if (calls.length > 0) await dispatchAsRoot(api, sudo, calls, calls.length, "take-over");
    const until = Date.now() + 600_000;
    while (await api.query.Game.Game.getValue({ at: "best" })) {
      if (Date.now() > until) throw new Error(`${target.label}: the game on chain did not end within 10 min of the take-over`);
      await sleep(2_000);
    }
  }
  if (!run.lite) await fundPlayers(api, sudo, players, PLAYER_FUNDS);
}

/** As root: schedules one game with `run.phases` from now, returning its play time and the phases to set back. */
async function scheduleOwnGame(
  api: PeopleApi,
  run: ChainRun,
  sudo: Keypair,
  chainPhases: Phases,
): Promise<{ gamePlayTime: number; phases: Phases; previous: Phases | undefined }> {
  const phases: Phases = { ...chainPhases, ...run.phases };
  const now = Number(await api.query.Timestamp.Now.getValue({ at: "best" }));
  // Slack of a few blocks: the chain starts the game only before its registration start.
  const gamePlayTime = Math.ceil(now / 1000) + phases.registration + phases.shuffle + phases.post_shuffle_margin + 30;
  const airdrops = run.draw ? [await buildDraw(api)] : [];
  const schedule = api.tx.Game.schedule_games({
    games_schedules: [{ game_play_time: gamePlayTime, rounds: run.rounds, max_group_size: run.maxGroupSize, airdrops, tenure_claim_window: 0 }],
  });
  await dispatchAsRoot(api, sudo, [api.tx.Game.set_game_phases({ phases }).decodedCall, schedule.decodedCall], 2, "schedule");
  return { gamePlayTime, phases, previous: Object.keys(run.phases).length > 0 ? chainPhases : undefined };
}

/**
 * A player's report as the app's game view and `buildReport` lay it out: per round, one vote per
 * co-player of its group in seat order, its own seat and empty seats left out, and every vote
 * `Person`. Undefined for a player missing from the roster or whose group reads back
 * inconsistent, for which the app shows no game view either.
 */
export async function buildReport(engine: GameEngine, player: Player, playerCount: number, maxGroupSize: number): Promise<ReportVote[][] | undefined> {
  const indices = await engine.playerIndices(player.address);
  if (!indices) return undefined;
  const rounds = await Promise.all(
    indices.map(async (ownIndex, round) => {
      const members = new Set((await engine.groupMembers(round, ownIndex, playerCount, maxGroupSize)).map((member) => member.index));
      const chairs = groupSeats(ownIndex, playerCount, maxGroupSize);
      if (members.size !== chairs.filter((chair) => chair.occupied).length || chairs.some((chair) => chair.occupied !== members.has(chair.index))) return undefined;
      return chairs.filter((chair) => chair.occupied && chair.index !== ownIndex).map((): ReportVote => "Person");
    }),
  );
  return rounds.every((votes): votes is ReportVote[] => votes !== undefined) ? rounds : undefined;
}

/**
 * Game `gameIndex` once the app's engine reads its roster, with the player count its groups
 * follow from. The engine reads at the finalized block, a few blocks behind the best one.
 */
async function readRoster(engine: GameEngine, gameIndex: number): Promise<{ current: PalletGame; playerCount: number }> {
  const until = Date.now() + 120_000;
  for (;;) {
    const current = await engine.game();
    if (current?.index === gameIndex) {
      const playerCount = statePlayerCount(current.state);
      if (playerCount !== undefined) return { current, playerCount };
    }
    if (Date.now() > until) throw new Error(`game ${gameIndex} shows no roster at the finalized block within 120 s`);
    await sleep(2_000);
  }
}

/**
 * Plays one game with `players` funded accounts: every player signs up at once, the chain
 * shuffles, and every player reports at once after the game's length. With a root key the game
 * is one this run schedules; without one the players join a scheduled game, reusing the same
 * accounts from game to game, so each pays its play deposit once. Every deadline is the chain's
 * clock, which a dev node runs at its own pace.
 */
export async function runChain(run: ChainRun): Promise<ChainResult> {
  const { target } = run;
  const { client, api, appClient, engine } = connectPeople(target);
  const pool = SigningPool.open(target);
  const timeline: ChainResult["timeline"] = [];
  const findings: string[] = [];
  const chainNow = async () => Number(await api.query.Timestamp.Now.getValue({ at: "best" }));
  let previousPhases: Phases | undefined;
  let watching = true;
  // On a live network the next game starts as soon as this one ends, so the end is a new index.
  let gameIndex: number | undefined;
  let blockFollower: BlockFollower | undefined;

  try {
    const { players } = run;
    const ownGame = target.sudo !== undefined && run.gameAt === undefined;
    const chainPhases = (await api.query.Game.StoredPhaseDurations.getValue()) ?? (await api.constants.Game.DefaultPhaseDurations());
    let phases = chainPhases;
    let gameAt = run.gameAt;
    if (run.draw && !(ownGame && (await readRootKey(api, target)))) {
      throw new Error(`--draw gives the bots draw tickets only in a game this run schedules with the chain's root key, and ${target.label} has none here`);
    }
    if (ownGame) {
      await clearAndFund(api, run, target.sudo!, players);
      const scheduled = await scheduleOwnGame(api, run, target.sudo!, chainPhases);
      gameAt = scheduled.gamePlayTime;
      phases = scheduled.phases;
      previousPhases = scheduled.previous;
    }
    // Before the game opens, so the binds don't take registration's blocks.
    const binds = run.lite ? await bindLiteBots(pool, players) : {};
    for (const [outcome, count] of Object.entries(binds)) {
      if (outcome.startsWith("refused")) findings.push(`bind ${outcome}: ${count}`);
    }

    blockFollower = await followBlockLoad(client, api);
    void (async () => {
      while (watching) {
        try {
          const current = await api.query.Game.Game.getValue({ at: "best" });
          const label = gameIndex !== undefined && current && current.index !== gameIndex ? "None" : stateLabel(current);
          if (timeline.at(-1)?.state !== label) {
            timeline.push({ state: label, at: Date.now() });
            console.log(`[chain] game: ${label}`);
          }
        } catch (error) {
          console.warn(`[chain] game state not read: ${(error as Error).message}`);
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

    // The players sign up as soon as the game takes sign-ups and report after it, so the run lasts
    // until the game: one further away than the run's wait fails at once.
    const signUpMs = 120_000 + Math.ceil(players.length / pool.size) * SIGN_UP_MS;
    const game = await waitForGame(engine, gameAt, ownGame ? 0 : signUpMs, run.registrationWaitMs);
    gameIndex = game.index;
    blockFollower.followGame(game.index);
    if (run.draw && game.airdrops_scheduled !== 1) {
      throw new Error(`game ${game.index} scheduled ${game.airdrops_scheduled} prize draws, not 1: fund ${GAME_AIRDROP_SOURCE} with the prize asset`);
    }
    // Funded only now on a live network: a deposit of the previous game counts until that game lets it go.
    if (!ownGame && !run.lite) await topUpPlayers(target, api, players);
    const { extrinsics: signUpExtrinsics, refusals } = await signSignUps(pool, players, run.draw);
    for (const [reason, count] of Object.entries(refusals)) {
      if (reason !== ALREADY_REGISTERED) findings.push(`sign-up not built, ${reason}: ${count}`);
    }

    console.log(`[chain] game ${game.index}: ${signUpExtrinsics.length} players sign up`);
    const signUp = await submitBurst(signUpExtrinsics, api, client, target.rpc, run.connections, () => game.registration_ends * 1000);
    console.log(`[chain] sign-ups: ${signUp.ok}/${signUp.submitted} in ${signUp.durationMs} ms`);
    if (signUp.inTime < signUpExtrinsics.length) {
      findings.push(`sign-up: ${signUpExtrinsics.length - signUp.inTime} of ${signUpExtrinsics.length} not in before registration ended`);
    }
    let lite: ChainResult["lite"] = null;
    if (run.lite) {
      const accounts = await api.query.System.Account.getValues(players.map((player) => [player.address]), { at: "best" });
      lite = { binds, withDeposit: accounts.filter((account) => account.data.reserved > 0n).length };
      console.log(`[chain] lite sign-ups: ${lite.withDeposit} of ${players.length} lite bots hold a deposit`);
      if (lite.withDeposit > 0) findings.push(`sign-up: ${lite.withDeposit} of ${players.length} lite bots hold a deposit`);
    }

    const untilGame = game.game_date * 1000 - (await chainNow());
    await waitFor((state) => state.startsWith("Reporting") || state === "None" || state.startsWith("Cancelling"), Math.max(0, untilGame) + 600_000, "Reporting");
    const lastState = timeline.at(-1)!.state;
    let report: BurstSummary | null = null;
    let claim: ClaimResult | null = null;
    if (!lastState.startsWith("Reporting")) {
      findings.push(`shuffle: the game went to ${lastState} instead of Reporting`);
    } else {
      // Built and signed now, while the last turns play, and sent once the last turn is over.
      const { current, playerCount } = await readRoster(engine, game.index);
      if (current.rounds !== run.rounds || current.max_group_size !== run.maxGroupSize) {
        findings.push(
          `game shape: the game plays ${current.rounds} rounds in groups of up to ${current.max_group_size}, the bots' messages assume ${run.rounds} of ${run.maxGroupSize}`,
        );
      }
      const reportEntries = await readAll(players, async (player) => ({
        player,
        fullReport: await buildReport(engine, player, playerCount, current.max_group_size).catch((error: Error) => {
          console.warn(`[chain] report of ${player.address} not built: ${error.message}`);
          return undefined;
        }),
      }));
      const reports = reportEntries.filter((entry): entry is { player: Player; fullReport: ReportVote[][] } => entry.fullReport !== undefined);
      if (reports.length < players.length) findings.push(`report: ${players.length - reports.length} of ${players.length} players' reports not built`);
      const chain = fromPapi(client, api);
      const reportExtrinsics = await pool.sign(
        reports.map(({ player, fullReport }) => ({ player, chain: "people" as const, signer: "participant" as const, tx: reportTx(chain, { fullReport }) })),
        "report",
      );
      while ((await chainNow()) < game.game_date * 1000 + run.playMs) await sleep(1_000);
      console.log(`[chain] ${reports.length} players report`);
      const burst = await submitBurst(
        reportExtrinsics,
        api,
        client,
        target.rpc,
        run.connections,
        (chainStart) => Math.min(chainStart + run.reportWindowMs, game.report_ends * 1000),
      );
      report = summarizeBurst(burst);
      console.log(`[chain] reports: ${burst.ok}/${burst.submitted}, ${burst.inTime} within ${run.reportWindowMs / 1000} s`);
      if (burst.inTime < reports.length) {
        findings.push(`report: ${reports.length - burst.inTime} of ${reports.length} not in within ${run.reportWindowMs / 1000} s`);
      }
      if (run.claim && burst.firstBlock !== null) {
        // The credits arrive on Asset Hub while the game still takes reports.
        try {
          claim = await claimCredits(target, appClient, players, game.index, burst.firstBlock, run.connections, pool);
          if (claim.claimable < claim.awarded) {
            findings.push(`claim: ${claim.awarded - claim.claimable} of ${claim.awarded} credits not claimable after ${Math.round(claim.claimableAfterMs / 1000)} s`);
          }
          if (claim.collections.length === 0) findings.push("claim: no claimable collection on Asset Hub");
          if (claim.burst && claim.claimed < claim.claimable) findings.push(`claim: ${claim.claimable - claim.claimed} of ${claim.claimable} credits not claimed on chain`);
          for (const [failure, count] of Object.entries(claim.burst?.failures ?? {})) findings.push(`claim ${failure}: ${count}`);
        } catch (error) {
          findings.push(`claim: stopped on ${(error as Error).message}`);
        }
      }
      const remainingMs = (game.report_ends + phases.player_process) * 1000 - (await chainNow());
      try {
        await waitFor((state) => state === "None" || state.startsWith("Cancelling"), Math.max(0, remainingMs) + 600_000, "game end");
        if (timeline.at(-1)!.state !== "None") findings.push(`player processing: the game went to ${timeline.at(-1)!.state}`);
      } catch (error) {
        findings.push(`player processing: ${(error as Error).message}`);
      }
    }
    let draw: DrawResult | null = null;
    if (run.draw && timeline.at(-1)!.state === "None") {
      try {
        draw = await settleDraw(engine, pool, client, api, target, players, game.index, run.connections);
        console.log(`[chain] draw: ${draw.tickets} tickets, ${draw.winners.length} winners, ${draw.claimed} claimed`);
        if (draw.tickets < players.length) findings.push(`draw: ${players.length - draw.tickets} of ${players.length} players entered no ticket`);
        if (draw.winners.length === 0) findings.push("draw: no winner");
        if (draw.claimed < draw.winners.length) findings.push(`draw: ${draw.winners.length - draw.claimed} of ${draw.winners.length} prizes not claimed`);
        for (const [reason, count] of Object.entries(draw.ineligible)) findings.push(`draw claim not eligible, ${reason}: ${count}`);
        for (const [failure, count] of Object.entries(draw.claimFailures)) findings.push(`draw claim ${failure}: ${count}`);
      } catch (error) {
        findings.push(`draw: stopped on ${(error as Error).message}`);
      }
    } else if (run.draw) {
      findings.push("draw: the game didn't end, so no prize was claimed");
    }
    for (const [failure, count] of Object.entries(signUp.failures)) findings.push(`sign-up ${failure}: ${count}`);
    for (const [failure, count] of Object.entries(report?.failures ?? {})) findings.push(`report ${failure}: ${count}`);
    // The game's last blocks are best, not yet finalized, when the run sees the game end.
    const lastBestBlock = blockFollower.bestNumber();
    const blocksComplete = await blockFollower.waitForBlock(lastBestBlock, FINALIZED_WAIT_MS);
    const blocks = [...blockFollower.blocks].sort((a, b) => a.number - b.number);
    const gameSummary = { index: game.index, gamePlayTime: game.game_date, registrationEnds: game.registration_ends, reportEnds: game.report_ends };
    const signUpSummary = summarizeBurst(signUp);
    const limits = findBlockLimits({ blocks, game: gameSummary, phases, signUp: signUpSummary, report });
    findings.push(...limits.findings);
    const notes = blockFollower.notes();
    if (!blocksComplete) notes.push(`finalized blocks up to #${lastBestBlock} not read within ${FINALIZED_WAIT_MS / 1000} s of the game end`);
    let proposals: Proposal[] | null = null;
    const gameBlocks = splitStates(blocks, game.index).flatMap((window) => window.blocks);
    if (target.network === "previewnet" && gameBlocks.length > 0) {
      const [first, last] = [gameBlocks[0], gameBlocks.at(-1)!];
      proposals = await readProposals(first.number, last.number, first.timestamp, last.timestamp).catch((error: Error) => {
        notes.push(`collator log not read: ${error.message}`);
        return null;
      });
    }

    const result: ChainResult = {
      layer: "chain",
      runId: run.runId,
      players: players.length,
      target: target.label,
      verdict: findings.length === 0 ? "pass" : "fail",
      findings,
      phases,
      game: gameSummary,
      timeline,
      signUp: signUpSummary,
      report,
      claim,
      blocks,
      proposals,
      notes,
      capacity: limits.capacity,
      lite,
      draw,
    };
    await mkdir(run.outDir, { recursive: true });
    await writeFile(join(run.outDir, `chain.n${players.length}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    watching = false;
    blockFollower?.stop();
    // The phases apply to every later game, so a run on a shared network sets them back.
    if (previousPhases && target.sudo) {
      await dispatchAsRoot(api, target.sudo, [api.tx.Game.set_game_phases({ phases: previousPhases }).decodedCall], 1, "restore phases").catch(
        (error: Error) => console.warn(`[chain] phases not restored: ${error.message}`),
      );
    }
    await pool.close();
    client.destroy();
  }
}
