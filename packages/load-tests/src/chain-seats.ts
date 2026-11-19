import { toHex } from "@jollity/statement-core";
import { statePlayerCount, type GameEngine, type PalletGroupMember } from "@jollity/protocol/src/engine";
import { readAll, retry, sleep, withTimeout } from "./time.js";

/** A run's bots as the chain seated them in a game: written by the runner, read by `host-ghost.ts`. */
export interface ChainSeats {
  /** Each bot's co-players by round, by account; a bot the game doesn't seat has none. */
  rounds: Record<string, string[][]>;
  /** Each co-player's communication identifier as registered on chain, hex; one without is absent. */
  identifiers: Record<string, string>;
}

const READ_MS = 30_000;

const readChain = <T>(read: () => Promise<T>, what: string): Promise<T> => retry(3, 1_000, () => withTimeout(read(), READ_MS, what));

const accountsOf = (members: PalletGroupMember[]) => members.flatMap((member) => (member.player.type === "Account" ? [member.player.value] : []));

/**
 * `bots`' groups by round in game `gameIndex`, as the app's game view reads them once the shuffle
 * seats the players, and the communication identifier each co-player registered. Fails when the
 * game shows no groups by `until`, or a read gets no answer in three attempts.
 */
export async function readChainSeats(engine: GameEngine, gameIndex: number, bots: string[], until: number): Promise<ChainSeats> {
  for (;;) {
    const game = await withTimeout(engine.game(), READ_MS, "game read").catch((error: Error) => {
      console.warn(`[seats] ${error.message}`);
      return undefined;
    });
    const seated = game?.index === gameIndex && (game.state.type === "Shuffle" || game.state.type === "Reporting");
    const playerCount = seated ? statePlayerCount(game.state) : undefined;
    if (game && playerCount !== undefined) {
      const rounds = await readAll(
        bots,
        async (bot) => {
          const indices = (await readChain(() => engine.playerIndices(bot), "seat read")) ?? [];
          return Promise.all(
            indices.map(async (ownIndex, round) =>
              accountsOf(await readChain(() => engine.groupMembers(round, ownIndex, playerCount, game.max_group_size), "group read")).filter((member) => member !== bot),
            ),
          );
        },
        50,
      );
      const peers = [...new Set(rounds.flat(2))];
      const identifiers = await readAll(peers, (peer) => readChain(() => engine.communicationIdentifier(peer), "identifier read"), 50);
      return {
        rounds: Object.fromEntries(bots.map((bot, position) => [bot, rounds[position]])),
        identifiers: Object.fromEntries(peers.flatMap((peer, position) => (identifiers[position] ? [[peer, toHex(identifiers[position])]] : []))),
      };
    }
    if (Date.now() > until) throw new Error(`game ${gameIndex} shows no groups by ${new Date(until).toISOString()}`);
    await sleep(2_000);
  }
}
