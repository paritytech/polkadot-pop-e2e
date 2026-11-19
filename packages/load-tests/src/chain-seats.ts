import { toHex } from "@jollity/statement-core";
import { statePlayerCount, type GameEngine, type PalletGame, type PalletGroupMember } from "@jollity/protocol/src/engine";
import { bump } from "./stats.js";
import { readAll, retry, sleep, withTimeout } from "./time.js";

/** How long one read of a game's groups may take before it counts as unanswered. */
export const GROUP_READ_MS = 30_000;

/** A run's bots as the chain seated them in a game: written by the runner, read by `host-ghost.ts`. */
export interface ChainSeats {
  /** Each seated bot's co-players by round, by account. */
  rounds: Record<string, string[][]>;
  /** Each co-player's communication identifier as registered on chain, hex. */
  identifiers: Record<string, string>;
  /** Bots without seats, by reason. */
  unseated: Record<string, number>;
}

/**
 * Game `gameIndex` once the shuffle seats its players, as the app's game view waits for it, with
 * the player count its groups follow from. Fails when the game shows no groups by `until`.
 */
export async function waitForGroups(engine: GameEngine, gameIndex: number, until: number): Promise<{ game: PalletGame; playerCount: number }> {
  let lastError = "";
  for (;;) {
    try {
      const game = await withTimeout(engine.game(), GROUP_READ_MS, "game read");
      const seated = game?.index === gameIndex && (game.state.type === "Shuffle" || game.state.type === "Reporting");
      const playerCount = seated ? statePlayerCount(game.state) : undefined;
      if (game && playerCount !== undefined) return { game, playerCount };
    } catch (error) {
      lastError = `; last read: ${(error as Error).message}`;
    }
    if (Date.now() > until) throw new Error(`game ${gameIndex} shows no groups by ${new Date(until).toISOString()}${lastError}`);
    await sleep(2_000);
  }
}

/** `address`'s seat and group members in each round, or undefined when the game doesn't seat it. */
export async function readGroups(
  engine: GameEngine,
  address: string,
  playerCount: number,
  maxGroupSize: number,
): Promise<Array<{ ownIndex: number; members: PalletGroupMember[] }> | undefined> {
  const indices = await engine.playerIndices(address);
  if (!indices) return undefined;
  return Promise.all(indices.map(async (ownIndex, round) => ({ ownIndex, members: await engine.groupMembers(round, ownIndex, playerCount, maxGroupSize) })));
}

const readChain = <T>(read: () => Promise<T>, what: string): Promise<T> => retry(3, 1_000, () => withTimeout(read(), GROUP_READ_MS, what));

const accountsOf = (members: PalletGroupMember[]) => members.flatMap((member) => (member.player.type === "Account" ? [member.player.value] : []));

/**
 * `bots`' groups by round in game `gameIndex`, as the app's game view reads them, and the
 * communication identifier each co-player registered. A bot whose seat read fails three times
 * has no seats, and a co-player whose identifier read fails has no identifier. Fails when the
 * game shows no groups by `until`.
 */
export async function readChainSeats(engine: GameEngine, gameIndex: number, bots: string[], until: number): Promise<ChainSeats> {
  const { game, playerCount } = await waitForGroups(engine, gameIndex, until);
  const unseated: Record<string, number> = {};
  const groups = await readAll(
    bots,
    (bot) =>
      readChain(() => readGroups(engine, bot, playerCount, game.max_group_size), "seat read").then(
        (rounds) => {
          if (!rounds) bump(unseated, "not in the game");
          return rounds?.map(({ members }) => accountsOf(members).filter((member) => member !== bot));
        },
        (error: Error) => {
          bump(unseated, error.message);
          return undefined;
        },
      ),
    50,
  );
  const rounds = Object.fromEntries(bots.flatMap((bot, position) => (groups[position] ? [[bot, groups[position]]] : [])));
  const peers = [...new Set(Object.values(rounds).flat(2))];
  const identifiers = await readAll(
    peers,
    (peer) =>
      readChain(() => engine.communicationIdentifier(peer), "identifier read").catch((error: Error) => {
        console.warn(`[seats] ${peer}: ${error.message}`);
        return null;
      }),
    50,
  );
  return {
    rounds,
    identifiers: Object.fromEntries(peers.flatMap((peer, position) => (identifiers[position] ? [[peer, toHex(identifiers[position])]] : []))),
    unseated,
  };
}
