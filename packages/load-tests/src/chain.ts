import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Enum } from "polkadot-api";
import { SIGNING_MS, signEntries, submitBurst, summarizeBurst, type BurstSummary } from "./burst.js";
import { claimCredits, type ClaimResult } from "./claim.js";
import { playersNotRegistered, signUpEntries, topUpPlayers, waitForGame, PLAYER_FUNDS, type OpenGame } from "./join.js";
import type { Keypair, Player } from "./keys.js";
import { dispatchAsRoot, fundPlayers } from "./root.js";
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
  /** Claiming the game's credits as NFTs on Asset Hub, when the run claims. */
  claim: ClaimResult | null;
  blocks: BlockLoad[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stateLabel(game: { state: { type: string; value?: unknown } } | undefined): string {
  if (!game) return "None";
  const step = (game.state.value as { step?: { type: string } } | undefined)?.step;
  return step ? `${game.state.type}.${step.type}` : game.state.type;
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
  await fundPlayers(api, sudo, players, PLAYER_FUNDS);
}

/** As root: schedules one game with `run.phases` from now, returning the phases to set back. */
async function scheduleOwnGame(api: PeopleApi, run: ChainRun, sudo: Keypair): Promise<{ phases: Phases; previous: Phases | undefined }> {
  const chainPhases = (await api.query.Game.StoredPhaseDurations.getValue()) ?? (await api.constants.Game.DefaultPhaseDurations());
  const phases: Phases = { ...chainPhases, ...run.phases };
  const now = Number(await api.query.Timestamp.Now.getValue({ at: "best" }));
  // Slack of a few blocks: the chain starts the game only before its registration start.
  const gamePlayTime = Math.ceil(now / 1000) + phases.registration + phases.shuffle + phases.post_shuffle_margin + 30;
  const schedule = api.tx.Game.schedule_games({
    games_schedules: [{ game_play_time: gamePlayTime, rounds: run.rounds, max_group_size: run.maxGroupSize, airdrops: [] }],
  });
  await dispatchAsRoot(api, sudo, [api.tx.Game.set_game_phases({ phases }).decodedCall, schedule.decodedCall], 2, "schedule");
  return { phases, previous: Object.keys(run.phases).length > 0 ? chainPhases : undefined };
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
 * Plays one game with `players` funded accounts: every player signs up at once, the chain
 * shuffles, and every player reports at once after the game's length. With a root key the game
 * is one this run schedules; without one the players join a scheduled game, reusing the same
 * accounts from game to game, so each pays its play deposit once. Every deadline is the chain's
 * clock, which a dev node runs at its own pace.
 */
export async function runChain(run: ChainRun): Promise<ChainResult> {
  const { target } = run;
  const { client, api } = connectPeople(target);
  const timeline: ChainResult["timeline"] = [];
  const blocks: BlockLoad[] = [];
  const findings: string[] = [];
  const chainNow = async () => Number(await api.query.Timestamp.Now.getValue({ at: "best" }));
  let previousPhases: Phases | undefined;
  let watching = true;
  // On a live network the next game starts as soon as this one ends, so the end is a new index.
  let gameIndex: number | undefined;

  try {
    const { players } = run;
    const ownGame = target.sudo !== undefined && run.gameAt === undefined;
    let phases: Phases;
    let signedSignUps: string[] = [];
    if (ownGame) {
      await clearAndFund(api, run, target.sudo!, players);
      // Fresh accounts, signed before the game exists, so none of registration goes to signing:
      // the sign-up is each player's first transaction, the report its second.
      signedSignUps = await signEntries(signUpEntries(api, players, 0), "sign-up");
      const scheduled = await scheduleOwnGame(api, run, target.sudo!);
      phases = scheduled.phases;
      previousPhases = scheduled.previous;
    } else {
      await topUpPlayers(target, api, players);
      phases = (await api.query.Game.StoredPhaseDurations.getValue()) ?? (await api.constants.Game.DefaultPhaseDurations());
    }

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
        const current = await api.query.Game.Game.getValue({ at: "best" }).catch(() => undefined);
        const label = gameIndex !== undefined && current && current.index !== gameIndex ? "None" : stateLabel(current);
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

    let game: OpenGame;
    if (ownGame) {
      await waitFor((state) => state === "Registration", 120_000, "Registration");
      game = (await api.query.Game.Game.getValue({ at: "best" }))!;
    } else {
      // The players sign up as soon as the game takes sign-ups and report after it, so the run
      // lasts until the game: one further away than the run's wait fails at once. Reused
      // accounts sign at their chain nonce, and a player already in this game skips its sign-up.
      game = await waitForGame(api, run.gameAt, 120_000 + players.length * SIGNING_MS, run.registrationWaitMs);
      if (game.game_date * 1000 - (await chainNow()) > run.registrationWaitMs) {
        throw new Error(`game ${game.index} plays at ${new Date(game.game_date * 1000).toISOString()}, later than this run's ${run.registrationWaitMs / 60_000} min wait; start the run later`);
      }
      signedSignUps = await signEntries(signUpEntries(api, await playersNotRegistered(api, players)), "sign-up");
    }
    gameIndex = game.index;

    console.log(`[chain] game ${game.index}: ${signedSignUps.length} players sign up`);
    const signUp = await submitBurst(signedSignUps, api, client, target.rpc, run.connections, () => game.registration_ends * 1000);
    console.log(`[chain] sign-ups: ${signUp.ok}/${signUp.submitted} in ${signUp.durationMs} ms`);
    if (signUp.inTime < signedSignUps.length) {
      findings.push(`sign-up: ${signedSignUps.length - signUp.inTime} of ${signedSignUps.length} not in before registration ended`);
    }

    const untilGame = game.game_date * 1000 - (await chainNow());
    await waitFor((state) => state.startsWith("Reporting") || state === "None" || state.startsWith("Cancelling"), Math.max(0, untilGame) + 600_000, "Reporting");
    const reached = timeline.at(-1)!.state;
    let report: BurstSummary | null = null;
    let claim: ClaimResult | null = null;
    if (!reached.startsWith("Reporting")) {
      findings.push(`shuffle: the game went to ${reached} instead of Reporting`);
    } else {
      // Signed now, while the last turns play, and sent once the last turn is over.
      const current = (await api.query.Game.Game.getValue({ at: "best" }))!;
      if (current.state.type !== "Reporting") throw new Error(`game left Reporting before the reports: ${stateLabel(current)}`);
      const reports = await buildReports(api, players, current.state.value.player_count, current.max_group_size, current.rounds);
      const signedReports = await signEntries(
        reports.map(({ player, fullReport }) => ({ signer: player, tx: api.tx.Game.report({ full_report: fullReport }), nonce: ownGame ? 1 : undefined })),
        "report",
      );
      while ((await chainNow()) < game.game_date * 1000 + run.playMs) await sleep(1_000);
      console.log(`[chain] ${reports.length} players report`);
      const burst = await submitBurst(
        signedReports,
        api,
        client,
        target.rpc,
        run.connections,
        (chainStart) => Math.min(chainStart + run.reportWindowMs, current.report_ends * 1000),
      );
      report = summarizeBurst(burst);
      console.log(`[chain] reports: ${burst.ok}/${burst.submitted}, ${burst.inTime} within ${run.reportWindowMs / 1000} s`);
      if (burst.inTime < reports.length) {
        findings.push(`report: ${reports.length - burst.inTime} of ${reports.length} not in within ${run.reportWindowMs / 1000} s`);
      }
      // Each `Person` vote a player receives awards it one credit, real players' votes included.
      // The game clears the votes as it ends, so they are read for as long as it reports.
      const personVotes = async () => {
        const rows = await api.query.Game.Players.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" });
        return rows.reduce((sum, row) => sum + (row?.yes_person ?? 0), 0);
      };
      let received = 0;
      while (timeline.at(-1)!.state.startsWith("Reporting")) {
        received = Math.max(received, await personVotes());
        await sleep(10_000);
      }
      received = Math.max(received, await personVotes());
      const remainingMs = (current.report_ends + phases.player_process) * 1000 - (await chainNow());
      await waitFor((state) => state === "None" || state.startsWith("Cancelling"), Math.max(0, remainingMs) + 600_000, "game end");
      if (timeline.at(-1)!.state !== "None") findings.push(`player processing: the game went to ${timeline.at(-1)!.state}`);
      if (run.claim && received > 0) {
        claim = await claimCredits(target, client, players, game.index, received, run.connections);
        if (claim.claimable < claim.awarded) {
          findings.push(`claim: ${claim.awarded - claim.claimable} of ${claim.awarded} credits not claimable after ${Math.round(claim.claimableAfterMs / 1000)} s`);
        }
        if (claim.collections.length === 0) findings.push("claim: no claimable collection on Asset Hub");
        for (const [failure, count] of Object.entries(claim.burst?.failures ?? {})) findings.push(`claim ${failure}: ${count}`);
      }
    }
    for (const [failure, count] of Object.entries(signUp.failures)) findings.push(`sign-up ${failure}: ${count}`);
    for (const [failure, count] of Object.entries(report?.failures ?? {})) findings.push(`report ${failure}: ${count}`);
    blockSubscription.unsubscribe();

    const result: ChainResult = {
      layer: "chain",
      runId: run.runId,
      players: players.length,
      target: target.label,
      verdict: findings.length === 0 ? "pass" : "fail",
      findings,
      phases,
      game: { index: game.index, gamePlayTime: game.game_date, registrationEnds: game.registration_ends, reportEnds: game.report_ends },
      timeline,
      signUp: summarizeBurst(signUp),
      report,
      claim,
      blocks: blocks.sort((a, b) => a.number - b.number),
    };
    await mkdir(run.outDir, { recursive: true });
    await writeFile(join(run.outDir, `chain.n${players.length}.json`), JSON.stringify(result, null, 2));
    return result;
  } finally {
    watching = false;
    // The phases apply to every later game, so a run on a shared network sets them back.
    if (previousPhases && target.sudo) {
      await dispatchAsRoot(api, target.sudo, [api.tx.Game.set_game_phases({ phases: previousPhases }).decodedCall], 1, "restore phases").catch(
        (error: Error) => console.warn(`[chain] phases not restored: ${error.message}`),
      );
    }
    client.destroy();
  }
}
