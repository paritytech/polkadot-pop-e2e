import { Enum, type PolkadotClient, type SizedHex } from "polkadot-api";
import { toHex } from "@polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { SIGNING_MS, signEntries, submitBurst, type BurstEntry } from "./burst.js";
import type { Keypair, Player } from "./keys.js";
import { statementAllowanceKey, submitToBestBlock } from "./root.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";

/** Balance per player, its play deposit included: the default 2 UNIT deposit, existential deposit and fees. */
export const PLAYER_FUNDS = 30_000_000_000n;

/** The game a player signs up to: its index and deadlines, in chain seconds. */
export interface OpenGame {
  index: number;
  registration_ends: number;
  game_date: number;
  report_ends: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
 * scheduled. Fails at once when that game opens registration later than `timeoutMs` from now,
 * and after `timeoutMs` in any case.
 */
export async function waitForGame(api: PeopleApi, gameAt: number | undefined, minRemainingMs: number, timeoutMs: number): Promise<OpenGame> {
  const until = Date.now() + timeoutMs;
  let reported: string | undefined;
  for (;;) {
    const [game, now, schedules, stored] = await Promise.all([
      api.query.Game.Game.getValue({ at: "best" }),
      api.query.Timestamp.Now.getValue({ at: "best" }),
      api.query.Game.GameSchedules.getValue({ at: "best" }),
      api.query.Game.StoredPhaseDurations.getValue({ at: "best" }),
    ]);
    const nowSeconds = Number(now) / 1000;
    const open = game?.state.type === "Registration" && game.registration_ends - nowSeconds >= minRemainingMs / 1000;
    if (open && (gameAt === undefined || game.game_date === gameAt)) return game;
    if (gameAt !== undefined && game?.game_date === gameAt) {
      throw new Error(`game ${game.index} at ${iso(gameAt)} UTC is past its registration (${game.state.type})`);
    }
    // A scheduled game starts, and opens registration, once the game before it has ended.
    const phases = stored ?? (await api.constants.Game.DefaultPhaseDurations());
    const position = gameAt === undefined ? 0 : schedules.findIndex((schedule) => schedule.game_play_time === gameAt);
    if (!schedules[position]) throw new Error(gameAt === undefined ? "no game is scheduled" : `no game is scheduled at ${iso(gameAt)} UTC`);
    const next = schedules[position].game_play_time;
    const before = position > 0 ? schedules[position - 1].game_play_time + phases.reporting : game?.report_ends;
    const opensBy = before === undefined ? nowSeconds : before + phases.player_process;
    if (opensBy > nowSeconds + (until - Date.now()) / 1000) {
      throw new Error(`the game at ${iso(next)} UTC opens registration around ${iso(opensBy)} UTC, after this run's ${timeoutMs / 60_000} min wait; start the run later`);
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
 * Gives every player without a statement allowance one by signing it up to a game, `gameAt` or
 * the closest scheduled, which grants the player's allowance for good. The funded account pays
 * each signing player's play deposit and fees.
 */
export async function signUpForAllowance(target: Target, players: Player[], gameAt: number | undefined, waitMs: number): Promise<void> {
  const { client, api } = connectPeople(target);
  try {
    const missing = await playersWithoutAllowance(client, players);
    console.log(`[mint] ${players.length - missing.length} of ${players.length} players have an allowance; ${missing.length} sign up`);
    if (missing.length === 0) return;
    await topUpPlayers(target, api, missing);
    const game = await waitForGame(api, gameAt, 120_000 + missing.length * SIGNING_MS, waitMs);
    const signed = await signEntries(signUpEntries(api, missing), "mint");
    const burst = await submitBurst(signed, api, client, target.rpc, 8, () => game.registration_ends * 1000);
    console.log(`[mint] ${burst.ok}/${burst.submitted} signed up to game ${game.index}`);
    if (burst.ok < missing.length) throw new Error(`${missing.length - burst.ok} sign-ups failed: ${JSON.stringify(burst.failures)}`);
  } finally {
    client.destroy();
  }
}

async function playersWithoutAllowance(client: PolkadotClient, players: Player[]): Promise<Player[]> {
  const missing: Player[] = [];
  for (let start = 0; start < players.length; start += 200) {
    const chunk = players.slice(start, start + 200);
    const values = await Promise.all(
      chunk.map((player) => client._request<string | null, [string]>("state_getStorage", [toHex(statementAllowanceKey(player))])),
    );
    chunk.forEach((player, position) => values[position] === null && missing.push(player));
  }
  return missing;
}
