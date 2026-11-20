import type { Transaction } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import type { GameRegistrationCapabilities } from "@parity/product-sdk-individuality";
import type { GameEngine, PalletGame } from "@jollity/protocol/src/engine";
import { hostSigner, signEntry } from "./burst.js";
import { communicationIdentifier, type Keypair, type Player } from "./keys.js";
import { submitToBestBlock } from "./root.js";
import type { BindOutcome, SigningPool, SignUpOutcome } from "./signing-pool.js";
import { bump } from "./stats.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { iso, readAll, sleep, withTimeout } from "./time.js";

/** Balance per player, its play deposit included: the default 2 UNIT deposit, existential deposit and fees. */
export const PLAYER_FUNDS = 30_000_000_000n;

/**
 * One sign-up's time on one signing thread, its register reads and its signature: about 0.08 s a
 * sign-up on 4 threads in today's runs.
 */
export const SIGN_UP_MS = 320;

/** One lite bot's bind, the binds going out in block-sized waves: 971 s for 1,000 bots on paseo-next-v2. */
export const BIND_MS = 1_000;

/** A sign-up burst's time beyond signing: sending every sign-up and waiting for its blocks. */
const SIGN_UP_BURST_MS = 120_000;

/** Time from opening registration until `players` sign-ups, signed on `threads` threads, are in blocks. */
export const signUpLeadMs = (players: number, threads: number) => Math.ceil(players / threads) * SIGN_UP_MS + SIGN_UP_BURST_MS;

/** The refusal of a player already signed up to the game, which a rerun meets for every earlier sign-up. */
export const ALREADY_REGISTERED = "AlreadyRegistered";

/** What a player brings to a sign-up beyond its account: a lite bot's personhood keys, and the VRF signer of a bot that enters the draws. */
export type SignUpKeys = Pick<GameRegistrationCapabilities, "personhood" | "signVrf">;

/**
 * `player`'s sign-up as the app makes it, signed but not sent: the app engine's `register`, with a
 * `submit` that only signs, so a burst can send every player's at once. It enters the draws the
 * app's draw rule lets it, and reports why it entered none.
 */
export async function signSignUp(engine: GameEngine, player: Player, keys: SignUpKeys): Promise<SignUpOutcome> {
  let extrinsic: string | undefined;
  let draws: { entered: number; kind?: string } = { entered: 0 };
  const capabilities = {
    account: { address: player.address, publicKey: player.publicKey },
    signer: hostSigner(player),
    submit: async (tx: unknown, creator: CommonSignerTxCreator) => {
      extrinsic = await signEntry({ creator, tx: tx as Transaction });
      return { ok: true as const };
    },
    ...keys,
  };
  try {
    const result = await engine.register(capabilities, communicationIdentifier(player.publicKey), { onDraws: (outcome) => (draws = outcome) });
    if (!result.ok) return { refusal: result.error };
  } catch (error) {
    return { refusal: (error as Error).message };
  }
  if (extrinsic === undefined) return { refusal: "no sign-up to sign" };
  return { extrinsic, drawsEntered: draws.entered, ...(draws.entered === 0 && draws.kind ? { drawSkip: draws.kind } : {}) };
}

/** What the app's draw rule leaves out: a player this game cannot make a member signs up without a ticket. */
export const NOT_MEMBER_YET = "not-member-yet";

export interface SignedSignUps {
  extrinsics: string[];
  /** Players the app's sign-up left out, by reason. */
  refusals: Record<string, number>;
  /** Sign-ups that enter the game's draws. */
  drawEntries: number;
  /** Draw tickets the sign-ups carry: one per sign-up and draw it enters. */
  drawTickets: number;
  /** Sign-ups that enter none, by the SDK's or the app's reason, such as `not-member-yet`. */
  drawSkips: Record<string, number>;
}

/** Every player's `signSignUp`, spread over the pool's threads. */
export async function signSignUps(pool: SigningPool, players: Player[], drawTicket: boolean): Promise<SignedSignUps> {
  const started = Date.now();
  const signed: SignedSignUps = { extrinsics: [], refusals: {}, drawEntries: 0, drawTickets: 0, drawSkips: {} };
  for (const outcome of await Promise.all(players.map((player) => pool.signUp(player, drawTicket)))) {
    if ("refusal" in outcome) {
      bump(signed.refusals, outcome.refusal);
      continue;
    }
    signed.extrinsics.push(outcome.extrinsic);
    if (outcome.drawsEntered > 0) signed.drawEntries++;
    signed.drawTickets += outcome.drawsEntered;
    if (outcome.drawSkip) bump(signed.drawSkips, outcome.drawSkip);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[sign-up] ${signed.extrinsics.length} of ${players.length} sign-ups signed in ${seconds} s on ${pool.size} threads ${JSON.stringify(signed.refusals)}; ${signed.drawEntries} enter the draws ${JSON.stringify(signed.drawSkips)}`,
  );
  return signed;
}

/**
 * A lite bot's game account bound to its lite person through the app engine's `bind`, which
 * submits the unsigned bind itself and completes at the best block. Only a seat on the free route
 * that isn't bound takes a bind, as in the app's flow: a returning player signs up as one, and a
 * stale binding is revised by the sign-up itself.
 */
export async function bindSeat(engine: GameEngine, player: Player, personhood: GameRegistrationCapabilities["personhood"]): Promise<BindOutcome> {
  const capabilities = {
    account: { address: player.address, publicKey: player.publicKey },
    signer: hostSigner(player),
    submit: async () => ({ ok: false as const, code: "InvalidSignUp" as const, message: "a bind signs nothing" }),
    personhood,
  };
  try {
    const seat = await engine.seat(player.address, { litePerson: true });
    if (seat.path !== "free") return { route: seat.path };
    if (seat.ready) return { binding: "existing" };
    const result = await engine.bind(capabilities);
    if (result.kind === "refused") return { refusal: `${result.refusal}: ${result.code}` };
    return { binding: result.kind === "bound" ? "new" : "existing" };
  } catch (error) {
    return { refusal: (error as Error).message };
  }
}

/** A bind's ring proof check weighs 29.3 ms, so a 2 s block's 85% normal class takes 58 binds. */
const BINDS_PER_WAVE = 50;

/** The lite bots of `players` whose game account has no binding to a lite person yet. */
export async function unboundBots(api: PeopleApi, players: Player[]): Promise<Player[]> {
  const aliases = await withTimeout(api.query.PeopleLite.AccountToAlias.getValues(players.map((player) => [player.address]), { at: "best" }), 60_000, "binding read");
  return players.filter((_, position) => aliases[position] === undefined);
}

/**
 * Binds every lite bot of `players` whose seat takes a bind: `BINDS_PER_WAVE` at once, the next
 * wave once the last one is in a block, so no block takes more binds than fit. `outcomes` counts
 * the binds made and the seats that took none, `refusals` the binds refused, by reason.
 */
export async function bindLiteBots(pool: SigningPool, players: Player[]): Promise<{ outcomes: Record<string, number>; refusals: Record<string, number>; durationMs: number }> {
  const startTime = Date.now();
  const outcomes: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  for (let start = 0; start < players.length; start += BINDS_PER_WAVE) {
    for (const outcome of await Promise.all(players.slice(start, start + BINDS_PER_WAVE).map((player) => pool.bind(player)))) {
      if ("refusal" in outcome) bump(refusals, outcome.refusal);
      else bump(outcomes, "binding" in outcome ? `${outcome.binding} binding` : `${outcome.route} route`);
    }
  }
  const durationMs = Date.now() - startTime;
  console.log(`[bind] done ${new Date().toISOString()}: ${players.length} lite bots in ${(durationMs / 1000).toFixed(1)} s ${JSON.stringify(outcomes)}, refused ${JSON.stringify(refusals)}`);
  return { outcomes, refusals, durationMs };
}

/** The game a run signs up to, with the time the run needs before its registration ends. */
export interface GamePlan {
  /** Undefined for a scheduled game while no game has an index to count from. */
  index: number | undefined;
  playsAt: number;
  registrationEnds: number;
  neededMs: number;
}

/** What the chain shows of its games: the current one, the scheduled ones and the phase durations, at chain time `now` (seconds). */
export interface GameCalendar {
  game: PalletGame | undefined;
  schedules: Array<{ game_play_time: number }>;
  phases: { registration: number; shuffle: number; post_shuffle_margin: number };
  now: number;
}

/**
 * What a run spends before its game's registration ends: `startMs` before it can do anything,
 * `bindMs` on binds that don't wait for the game to open, then `signUpMs` once it is open.
 */
export interface SignUpLead {
  startMs?: number;
  bindMs: number;
  signUpMs: number;
}

/**
 * The game playing at `gameAt` (chain seconds), or else the current game while it takes sign-ups,
 * or else the next one scheduled. Fails when the game's registration ends before `lead` is over,
 * naming the next game that leaves enough time.
 */
export function pickGame(calendar: GameCalendar, gameAt: number | undefined, lead: SignUpLead): GamePlan {
  const { game, schedules, phases, now } = calendar;
  const candidates = [
    ...(game?.state.type === "Registration" ? [{ index: game.index, playsAt: game.game_date, opensAt: now, registrationEnds: game.registration_ends }] : []),
    ...schedules.map(({ game_play_time: playsAt }, position) => ({
      index: game && game.index + 1 + position,
      playsAt,
      opensAt: playsAt - phases.registration - phases.shuffle - phases.post_shuffle_margin,
      registrationEnds: playsAt - phases.shuffle - phases.post_shuffle_margin,
    })),
  ];
  const startMs = lead.startMs ?? 0;
  const readyAt = (candidate: (typeof candidates)[number]) => Math.max(now * 1000 + startMs + lead.bindMs, candidate.opensAt * 1000) + lead.signUpMs;
  const plan = (candidate: (typeof candidates)[number]): GamePlan => ({
    index: candidate.index,
    playsAt: candidate.playsAt,
    registrationEnds: candidate.registrationEnds,
    neededMs: readyAt(candidate) - now * 1000,
  });
  const target = gameAt === undefined ? candidates[0] : candidates.find((candidate) => candidate.playsAt === gameAt);
  if (!target) {
    if (gameAt !== undefined && game?.game_date === gameAt) throw new Error(`game ${game.index} at ${iso(gameAt)} is past its registration (${game.state.type})`);
    throw new Error(gameAt === undefined ? "no game is scheduled" : `no game is scheduled at ${iso(gameAt)}`);
  }
  if (readyAt(target) <= target.registrationEnds * 1000) return plan(target);
  const next = candidates.find((candidate) => candidate.playsAt > target.playsAt && readyAt(candidate) <= candidate.registrationEnds * 1000);
  const label = (candidate: (typeof candidates)[number]) => `game ${candidate.index ?? "next"} at ${iso(candidate.playsAt)}`;
  throw new Error(
    `${label(target)}: registration ends ${iso(target.registrationEnds)}, ${target.registrationEnds - now} s from now, and the run needs ${Math.round(plan(target).neededMs / 1000)} s` +
      ` (start-up ${Math.round(startMs / 1000)} s, binds ${Math.round(lead.bindMs / 1000)} s, sign-ups ${Math.round(lead.signUpMs / 1000)} s); ` +
      (next ? `the next game that fits is ${label(next)}, --game-at ${next.playsAt}` : "no scheduled game fits"),
  );
}

/** The chain's phase durations: `Game.StoredPhaseDurations`, or else the pallet's defaults. */
export async function readPhaseDurations(api: PeopleApi) {
  return (await api.query.Game.StoredPhaseDurations.getValue()) ?? (await api.constants.Game.DefaultPhaseDurations());
}

/** `pickGame` over the chain's current calendar: the games as the app's engine reads them, the phase durations as the chain applies them. */
export async function planGame(engine: GameEngine, api: PeopleApi, gameAt: number | undefined, lead: SignUpLead): Promise<GamePlan> {
  const [game, schedules, phases, now] = await withTimeout(Promise.all([engine.game(), engine.schedules(), readPhaseDurations(api), engine.now()]), 60_000, "game calendar read");
  return pickGame({ game, schedules, phases, now }, gameAt, lead);
}

/** How long a game just scheduled may take to show in the finalized schedule the engine reads. */
const SCHEDULE_FINALITY_MS = 60_000;

/**
 * The game players sign up to, once the app's engine reads it in registration with at least
 * `minRemainingMs` of it left by chain time: the one playing at `gameAt` (chain seconds), or else
 * the closest one scheduled. Fails at once when that game plays later than `timeoutMs` from now,
 * and after `timeoutMs` in any case.
 */
export async function waitForGame(engine: GameEngine, gameAt: number | undefined, minRemainingMs: number, timeoutMs: number): Promise<PalletGame> {
  const started = Date.now();
  const until = started + timeoutMs;
  let reported: string | undefined;
  for (;;) {
    const [game, nowSeconds, schedules] = await Promise.all([engine.game(), engine.now(), engine.schedules()]);
    // The run lasts until the game is over, so the wait bounds when the game plays, not only when it opens.
    const requirePlayWithinWait = (playTime: number) => {
      if (playTime > nowSeconds + (until - Date.now()) / 1000) {
        throw new Error(`the game at ${iso(playTime)} plays after this run's ${timeoutMs / 60_000} min wait; start the run later`);
      }
    };
    const open = game?.state.type === "Registration" && game.registration_ends - nowSeconds >= minRemainingMs / 1000;
    if (open && (gameAt === undefined || game.game_date === gameAt)) {
      requirePlayWithinWait(game.game_date);
      return game;
    }
    if (gameAt !== undefined && game?.game_date === gameAt) {
      throw new Error(`game ${game.index} at ${iso(gameAt)} is past its registration (${game.state.type})`);
    }
    const position = gameAt === undefined ? 0 : schedules.findIndex((schedule) => schedule.game_play_time === gameAt);
    const next = schedules[position]?.game_play_time;
    if (next === undefined) {
      if (gameAt !== undefined && Date.now() - started < SCHEDULE_FINALITY_MS) {
        await sleep(5_000);
        continue;
      }
      throw new Error(gameAt === undefined ? "no game is scheduled" : `no game is scheduled at ${iso(gameAt)}`);
    }
    requirePlayWithinWait(next);
    const state = game ? `game ${game.index} at ${iso(game.game_date)} is in ${game.state.type}` : "no game is running";
    if (state !== reported) console.log(`[join] ${state}; waiting for the game at ${iso(next)} to open registration`);
    reported = state;
    if (Date.now() > until) throw new Error(`no game opened registration within ${timeoutMs / 60_000} min; ${state}`);
    await sleep(5_000);
  }
}

export function requireFunder(target: Target): Keypair {
  if (!target.funder) throw new Error(`${target.label}: no funded account to pay the players; set TEST_MNEMONIC`);
  return target.funder;
}

/**
 * Tops every player up to `PLAYER_FUNDS` from the target's funder, counting a deposit it already
 * has reserved from an earlier game. Fails before transferring anything when the funder can't
 * cover it, saying how much to send where.
 */
export async function topUpPlayers(target: Target, api: PeopleApi, players: Player[]): Promise<void> {
  const funder = requireFunder(target);
  const accounts = await api.query.System.Account.getValues(players.map((player) => [player.address]), { at: "best" });
  const shortfalls = players
    .map((player, position) => ({ player, planck: PLAYER_FUNDS - accounts[position].data.free - accounts[position].data.reserved }))
    .filter(({ planck }) => planck > 0n);
  const needed = shortfalls.reduce((sum, { planck }) => sum + planck, 0n);
  const available = (await api.query.System.Account.getValue(funder.address, { at: "best" })).data.free;
  // Fees of the transfer batches, with room to spare.
  const margin = 10_000_000_000n;
  console.log(`[fund] ${shortfalls.length} of ${players.length} players need ${Number(needed) / 1e10} UNIT from ${funder.address}`);
  if (needed + margin > available) {
    throw new Error(
      `${funder.address} has ${Number(available) / 1e10} UNIT on ${target.label}'s People chain; send it at least ${Math.ceil(Number(needed + margin - available) / 1e10)} UNIT more`,
    );
  }
  for (let start = 0; start < shortfalls.length; start += 500) {
    const calls = shortfalls
      .slice(start, start + 500)
      .map(({ player, planck }) => api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: player.address }, value: planck }).decodedCall);
    const included = await submitToBestBlock(api.tx.Utility.batch_all({ calls }), funder);
    console.log(`[fund] ${Math.min(start + 500, shortfalls.length)}/${shortfalls.length} in #${included.block.number}`);
  }
}

/**
 * Whether a message machine plays `game` now: some of its bots are signed up, the game hasn't
 * started, and it is the run's game, the one playing at `gameAt` (chain seconds) when given. A
 * sign-up goes only into a game in registration, so without `gameAt` the game in registration or
 * its shuffle is the one the bots signed up to; with it, bots another run signed up to an earlier
 * game don't count.
 */
export function isFollowedGame(game: PalletGame, signedUp: boolean, now: number, gameAt: number | undefined): boolean {
  const seating = game.state.type === "Registration" || game.state.type === "Shuffle";
  return seating && signedUp && game.game_date > now && (gameAt === undefined || game.game_date === gameAt);
}

/**
 * The game a separate chain run signs `players` up to, once one of them is signed up and the
 * game hasn't started, by `isFollowedGame`. Fails after `timeoutMs`, also when the chain stops
 * answering, with the last failed check's error.
 */
export async function waitForSignUp(target: Target, players: Player[], gameAt: number | undefined, timeoutMs: number): Promise<PalletGame> {
  let { client, engine } = connectPeople(target);
  const until = Date.now() + timeoutMs;
  let lastError: string | undefined;
  let reported: number | undefined;
  try {
    for (;;) {
      try {
        const [game, rows, now] = await withTimeout(
          Promise.all([engine.game(), readAll(players, (player) => engine.player(player.address)), engine.now()]),
          30_000,
          "sign-up check",
        );
        const signedUp = rows.some((row) => row?.registered);
        if (game && isFollowedGame(game, signedUp, now, gameAt)) return game;
        if (game && signedUp && gameAt !== undefined && reported !== game.index) {
          console.log(`[host] game ${game.index} at ${iso(game.game_date)} has this machine's bots; waiting for the run's game at ${iso(gameAt)}`);
          reported = game.index;
        }
      } catch (error) {
        lastError = (error as Error).message;
        console.warn(`[host] ${lastError}; reconnecting`);
        client.destroy();
        ({ client, engine } = connectPeople(target));
      }
      if (Date.now() > until) {
        const cause = lastError ? `; last check failed: ${lastError}` : "";
        const game = gameAt === undefined ? "a game" : `the game at ${iso(gameAt)}`;
        throw new Error(`none of this machine's bots was signed up to ${game} within ${timeoutMs / 60_000} min${cause}`);
      }
      await sleep(5_000);
    }
  } finally {
    client.destroy();
  }
}
