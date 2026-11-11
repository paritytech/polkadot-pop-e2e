import type { PolkadotClient, SizedHex } from "polkadot-api";
import { toHex } from "@polkadot-api/utils";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import { submitBurst, type BurstEntry } from "./burst.js";
import type { Keypair, Player } from "./keys.js";
import { statementAllowanceKey, transferToPlayers } from "./root.js";
import { RpcConnection } from "./rpc.js";
import { connectPeople, type PeopleApi, type Target } from "./target.js";

/** Free balance per player: the default 2 UNIT play deposit, existential deposit and fees. */
export const PLAYER_FUNDS = 30_000_000_000n;

/** The game a player signs up to: its index and deadlines, in chain seconds. */
export interface OpenGame {
  index: number;
  registration_ends: number;
  game_date: number;
  report_ends: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * The game in registration with at least `minRemainingMs` of it left by chain time, waiting
 * for the next one when the current game is past that. Fails after `timeoutMs`.
 */
export async function waitForOpenRegistration(api: PeopleApi, minRemainingMs: number, timeoutMs: number): Promise<OpenGame> {
  const until = Date.now() + timeoutMs;
  let reported: string | undefined;
  for (;;) {
    const [game, now] = await Promise.all([api.query.Game.Game.getValue({ at: "best" }), api.query.Timestamp.Now.getValue({ at: "best" })]);
    if (game?.state.type === "Registration" && game.registration_ends * 1000 - Number(now) >= minRemainingMs) return game;
    const state = game ? `game ${game.index} is in ${game.state.type}` : "no game is running";
    if (state !== reported) console.log(`[join] ${state}; waiting for a game in registration`);
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
 * Gives every player without a statement allowance one by signing it up to the game in
 * registration, which grants the player's allowance for good. The funded account pays each
 * signing player's play deposit and fees.
 */
export async function signUpForAllowance(target: Target, players: Player[], waitMs: number): Promise<void> {
  const funder = requireFunder(target);
  const { client, api } = connectPeople(target);
  const connections = await Promise.all(Array.from({ length: 8 }, (_, i) => RpcConnection.open(target.rpc[i % target.rpc.length], 15_000)));
  try {
    const missing = await playersWithoutAllowance(client, players);
    console.log(`[mint] ${players.length - missing.length} of ${players.length} players have an allowance; ${missing.length} sign up`);
    if (missing.length === 0) return;
    await transferToPlayers(api, funder, missing, PLAYER_FUNDS);
    const game = await waitForOpenRegistration(api, 120_000, waitMs);
    const burst = await submitBurst(signUpEntries(api, missing), api, client, connections, () => game.registration_ends * 1000);
    console.log(`[mint] ${burst.ok}/${burst.submitted} signed up to game ${game.index}`);
    if (burst.ok < missing.length) throw new Error(`${missing.length - burst.ok} sign-ups failed: ${JSON.stringify(burst.failures)}`);
  } finally {
    for (const connection of connections) connection.close();
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
