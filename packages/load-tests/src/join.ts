import { Enum, type SizedHex } from "polkadot-api";
import { toHex } from "@polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import type { BurstEntry } from "./burst.js";
import type { Keypair, Player } from "./keys.js";
import { submitToBestBlock } from "./root.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";
import { sleep } from "./time.js";

/** Balance per player, its play deposit included: the default 2 UNIT deposit, existential deposit and fees. */
export const PLAYER_FUNDS = 30_000_000_000n;

/** The game a player signs up to: its index and deadlines, in chain seconds. */
export interface OpenGame {
  index: number;
  registration_ends: number;
  game_date: number;
  report_ends: number;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");

/** A deterministic stand-in for the player's P-256 communication key, which the chain only stores. */
function identifierKey(player: Player): SizedHex<65> {
  const seed = blake2b256(player.publicKey);
  return toHex(new Uint8Array([4, ...seed, ...blake2b256(seed)])) as SizedHex<65>;
}

/** Each player's `sign_up_with_account`; without `nonce`, the chain's next nonce of each player. */
export function signUpEntries(api: PeopleApi, players: Player[], nonce?: number): BurstEntry[] {
  return players.map((player) => ({
    signer: player,
    tx: api.tx.Game.sign_up_with_account({ identifier_key: identifierKey(player), airdrops: undefined }),
    nonce,
  }));
}

/** The players not yet signed up to the game in progress, so a rerun skips the others. */
export async function playersNotRegistered(api: PeopleApi, players: Player[]): Promise<Player[]> {
  const rows = await api.query.Game.Players.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" });
  return players.filter((_, position) => !rows[position]?.registered);
}

/**
 * The game players sign up to, once it is in registration with at least `minRemainingMs` of it
 * left by chain time: the one playing at `gameAt` (chain seconds), or else the closest one
 * scheduled. Fails at once when that game plays later than `timeoutMs` from now, and after
 * `timeoutMs` in any case.
 */
export async function waitForGame(api: PeopleApi, gameAt: number | undefined, minRemainingMs: number, timeoutMs: number): Promise<OpenGame> {
  const until = Date.now() + timeoutMs;
  let reported: string | undefined;
  for (;;) {
    const [game, now, schedules] = await Promise.all([
      api.query.Game.Game.getValue({ at: "best" }),
      api.query.Timestamp.Now.getValue({ at: "best" }),
      api.query.Game.GameSchedules.getValue({ at: "best" }),
    ]);
    const nowSeconds = Number(now) / 1000;
    const open = game?.state.type === "Registration" && game.registration_ends - nowSeconds >= minRemainingMs / 1000;
    if (open && (gameAt === undefined || game.game_date === gameAt)) return game;
    if (gameAt !== undefined && game?.game_date === gameAt) {
      throw new Error(`game ${game.index} at ${iso(gameAt)} UTC is past its registration (${game.state.type})`);
    }
    const position = gameAt === undefined ? 0 : schedules.findIndex((schedule) => schedule.game_play_time === gameAt);
    if (!schedules[position]) throw new Error(gameAt === undefined ? "no game is scheduled" : `no game is scheduled at ${iso(gameAt)} UTC`);
    const next = schedules[position].game_play_time;
    // The run lasts until the game is over, so the wait bounds when the game plays, not only when it opens.
    if (next > nowSeconds + (until - Date.now()) / 1000) {
      throw new Error(`the game at ${iso(next)} UTC plays after this run's ${timeoutMs / 60_000} min wait; start the run later`);
    }
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
 * holds from an earlier game. Fails before transferring anything when the funder can't cover it,
 * saying how much to send where.
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
 * message machine finds the game a separate chain run signs its bots up to. Fails when the game
 * that was open closes sign-ups without any of them, so a chain run that stopped early doesn't
 * hold the machine for the whole `timeoutMs`, and after `timeoutMs` in any case.
 */
export async function waitForSignUp(target: Target, players: Player[], timeoutMs: number): Promise<OpenGame> {
  const { client, api } = connectPeople(target);
  const until = Date.now() + timeoutMs;
  let openGame: number | undefined;
  try {
    for (;;) {
      const [game, rows, now] = await Promise.all([
        api.query.Game.Game.getValue({ at: "best" }),
        api.query.Game.Players.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" }),
        api.query.Timestamp.Now.getValue({ at: "best" }),
      ]);
      const signedUp = rows.some((row) => row?.registered);
      if (game && signedUp && game.game_date * 1000 > Number(now)) return game;
      if (game?.state.type === "Registration") openGame = game.index;
      else if (game && game.index === openGame) throw new Error(`game ${game.index} closed sign-ups without any of this machine's bots`);
      if (Date.now() > until) throw new Error(`none of this machine's bots was signed up to a game within ${timeoutMs / 60_000} min`);
      await sleep(5_000);
    }
  } finally {
    client.destroy();
  }
}
