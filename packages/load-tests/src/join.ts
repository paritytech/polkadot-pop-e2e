import type { Transaction } from "polkadot-api";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import type { GameRegistrationCapabilities } from "@parity/product-sdk-individuality";
import type { GameEngine, PalletGame } from "@jollity/protocol/src/engine";
import { hostSigner, signEntry } from "./burst.js";
import { communicationIdentifier, type Keypair, type Player } from "./keys.js";
import { submitToBestBlock } from "./root.js";
import type { BindOutcome, SigningOutcome, SigningPool } from "./signing-pool.js";
import { bump } from "./stats.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { readAll, sleep, withTimeout } from "./time.js";

/** Balance per player, its play deposit included: the default 2 UNIT deposit, existential deposit and fees. */
export const PLAYER_FUNDS = 30_000_000_000n;

/**
 * The CPU time one sign-up takes on one core of a CI runner, its fee estimate and its signature
 * each decoding the whole runtime metadata: 172.5 s for 300 players on previewnet, on one thread.
 */
export const SIGN_UP_MS = 600;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");

/** The refusal of a player already signed up to the game, which a rerun meets for every earlier sign-up. */
export const ALREADY_REGISTERED = "AlreadyRegistered";

/** What a player brings to a sign-up beyond its account: a lite bot's personhood keys, and the VRF signer of a bot that enters the draws. */
export type SignUpKeys = Pick<GameRegistrationCapabilities, "personhood" | "signVrf">;

/**
 * `player`'s sign-up as the app makes it, signed but not sent: the app engine's `register`, with a
 * `submit` that only signs, so a burst can send every player's at once.
 */
export async function signSignUp(engine: GameEngine, player: Player, keys: SignUpKeys): Promise<SigningOutcome> {
  let extrinsic: string | undefined;
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
    const result = await engine.register(capabilities, communicationIdentifier(player.publicKey));
    if (!result.ok) return { refusal: result.error };
  } catch (error) {
    return { refusal: (error as Error).message };
  }
  return extrinsic === undefined ? { refusal: "no sign-up to sign" } : { extrinsic };
}

/** Every player's `signSignUp`, spread over the pool's threads; `refusals` counts the players left out, by reason. */
export async function signSignUps(pool: SigningPool, players: Player[], drawTicket: boolean): Promise<{ extrinsics: string[]; refusals: Record<string, number> }> {
  const started = Date.now();
  const refusals: Record<string, number> = {};
  const extrinsics: string[] = [];
  for (const outcome of await Promise.all(players.map((player) => pool.signUp(player, drawTicket)))) {
    if ("extrinsic" in outcome) extrinsics.push(outcome.extrinsic);
    else bump(refusals, outcome.refusal);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[sign-up] ${extrinsics.length} of ${players.length} sign-ups signed in ${seconds} s on ${pool.size} threads ${JSON.stringify(refusals)}`);
  return { extrinsics, refusals };
}

/**
 * A lite bot's game account bound to its lite person through the app engine's `bind`, which
 * submits the unsigned bind itself and settles at the best block.
 */
export async function bindSeat(engine: GameEngine, player: Player, personhood: GameRegistrationCapabilities["personhood"]): Promise<BindOutcome> {
  const capabilities = {
    account: { address: player.address, publicKey: player.publicKey },
    signer: hostSigner(player),
    submit: async () => ({ ok: false as const, code: "InvalidSignUp" as const, message: "a bind signs nothing" }),
    personhood,
  };
  try {
    const result = await engine.bind(capabilities);
    return result.kind === "refused" ? { refusal: `${result.refusal}: ${result.code}` } : { bound: result.kind };
  } catch (error) {
    return { refusal: (error as Error).message };
  }
}

/** A bind's ring proof check weighs 29.3 ms, so a 2 s block's 85% normal class takes 58 binds. */
const BINDS_PER_WAVE = 50;

/**
 * Binds every lite bot that isn't bound yet, before the sign-up burst: `BINDS_PER_WAVE` at once,
 * the next wave once the last one is in a block, so no block takes more binds than fit. A bot
 * bound already, also from an earlier game, counts as `already-bound`.
 */
export async function bindLiteBots(pool: SigningPool, players: Player[]): Promise<Record<string, number>> {
  const started = Date.now();
  const outcomes: Record<string, number> = {};
  for (let start = 0; start < players.length; start += BINDS_PER_WAVE) {
    for (const outcome of await Promise.all(players.slice(start, start + BINDS_PER_WAVE).map((player) => pool.bind(player)))) {
      bump(outcomes, "bound" in outcome ? outcome.bound : `refused: ${outcome.refusal}`);
    }
  }
  console.log(`[bind] ${players.length} lite bots in ${((Date.now() - started) / 1000).toFixed(1)} s ${JSON.stringify(outcomes)}`);
  return outcomes;
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
        throw new Error(`the game at ${iso(playTime)} UTC plays after this run's ${timeoutMs / 60_000} min wait; start the run later`);
      }
    };
    const open = game?.state.type === "Registration" && game.registration_ends - nowSeconds >= minRemainingMs / 1000;
    if (open && (gameAt === undefined || game.game_date === gameAt)) {
      requirePlayWithinWait(game.game_date);
      return game;
    }
    if (gameAt !== undefined && game?.game_date === gameAt) {
      throw new Error(`game ${game.index} at ${iso(gameAt)} UTC is past its registration (${game.state.type})`);
    }
    const position = gameAt === undefined ? 0 : schedules.findIndex((schedule) => schedule.game_play_time === gameAt);
    const next = schedules[position]?.game_play_time;
    if (next === undefined) {
      if (gameAt !== undefined && Date.now() - started < SCHEDULE_FINALITY_MS) {
        await sleep(5_000);
        continue;
      }
      throw new Error(gameAt === undefined ? "no game is scheduled" : `no game is scheduled at ${iso(gameAt)} UTC`);
    }
    requirePlayWithinWait(next);
    const state = game ? `game ${game.index} at ${iso(game.game_date)} UTC is in ${game.state.type}` : "no game is running";
    if (state !== reported) console.log(`[join] ${state}; waiting for the game at ${iso(next)} UTC to open registration`);
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
 * The game any of `players` is signed up to, once one is and that game hasn't started: how a
 * message machine finds the game a separate chain run signs its bots up to. Fails after
 * `timeoutMs`, also when the chain stops answering, with the last failed check's error.
 */
export async function waitForSignUp(target: Target, players: Player[], timeoutMs: number): Promise<PalletGame> {
  let { client, engine } = connectPeople(target);
  const until = Date.now() + timeoutMs;
  let lastError: string | undefined;
  try {
    for (;;) {
      try {
        const [game, rows, now] = await withTimeout(
          Promise.all([engine.game(), readAll(players, (player) => engine.player(player.address)), engine.now()]),
          30_000,
          "sign-up check",
        );
        const signedUp = rows.some((row) => row?.registered);
        if (game && signedUp && game.game_date > now) return game;
      } catch (error) {
        lastError = (error as Error).message;
        console.warn(`[host] ${lastError}; reconnecting`);
        client.destroy();
        ({ client, engine } = connectPeople(target));
      }
      if (Date.now() > until) {
        const cause = lastError ? `; last check failed: ${lastError}` : "";
        throw new Error(`none of this machine's bots was signed up to a game within ${timeoutMs / 60_000} min${cause}`);
      }
      await sleep(5_000);
    }
  } finally {
    client.destroy();
  }
}
