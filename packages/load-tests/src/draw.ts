import { AccountId, Binary, type PolkadotClient } from "polkadot-api";
import { mergeUint8 } from "@polkadot-api/utils";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import { claimPrizeTx, fromPapi, gameAirdropEventId } from "@parity/product-sdk-individuality";
import type { GameEngine, PalletDraw } from "@jollity/protocol/src/engine";
import { submitBurst } from "./burst.js";
import { Histogram, type QuantileSummary } from "./histogram.js";
import type { Player } from "./keys.js";
import type { SigningPool } from "./signing-pool.js";
import { bump } from "./stats.js";
import type { PeopleApi, Target } from "./target.js";
import { readAll, sleep } from "./time.js";

type ScheduledAirdrop = Parameters<PeopleApi["tx"]["Game"]["schedule_games"]>[0]["games_schedules"][number]["airdrops"][number];

/** The account the Game pallet pays its draws' prizes from: `PalletId(*b"pop/gads")`. */
export const GAME_AIRDROP_SOURCE = ss58Address(mergeUint8([new TextEncoder().encode("modlpop/gads"), new Uint8Array(20)]));

/**
 * The prize draw of a game the run schedules: the chain's first supported prize asset at the
 * least amount the pot takes, 5 winners out of everyone who entered, drawn a minute after play
 * and claimable for 3 days, as live games draw.
 */
export async function buildDraw(api: PeopleApi): Promise<ScheduledAirdrop> {
  const [asset] = await api.query.Airdrop.SupportedAssets.getEntries({ at: "best" });
  if (!asset) throw new Error("the chain pays no prize asset: Airdrop.SupportedAssets is empty");
  return { draw_offset: 60, claim_window: 259_200, prize: { asset_id: asset.keyArgs[0], asset_amount: asset.value, max_winners: 5, winner_cap: 1_000_000 } };
}

export interface DrawResult {
  /** The game's prize draws. */
  draws: number;
  /** Bots' tickets over every draw. */
  tickets: number;
  /** The winning bots' game accounts, once per draw won. */
  winners: string[];
  /** Winners whose claim the chain would refuse, by the app's reason. */
  ineligible: Record<string, number>;
  claimed: number;
  /** Claims that failed, by error. */
  claimFailures: Record<string, number>;
  /** From submitting a claim to its block. */
  claimMs: QuantileSummary;
  /** The prize assets the winners hold after their claims, in base units. */
  prizeHeld: string;
}

/** The airdrop event states before its winners are final. */
const DRAWING: Record<string, true> = { Scheduled: true, Registering: true, AwaitingEntropy: true, DrawWinners: true };

const slotKey = (slot: string) => slot.replace(/^0x/i, "").toLowerCase();

/**
 * Once every prize draw of game `gameIndex` has its winners, counts the bots' tickets and wins,
 * and each winner the app would let claim claims its prize into its own game account with the
 * SDK's `claimPrizeTx`, signed as the score participant as the app signs it. Each draw is read
 * once, its tickets and winners for every bot alike. Call it after the game's player processing,
 * which makes the winners eligible.
 */
export async function settleDraw(
  engine: GameEngine,
  pool: SigningPool,
  client: PolkadotClient,
  api: PeopleApi,
  target: Target,
  players: Player[],
  gameIndex: number,
  connections: number,
): Promise<DrawResult> {
  const until = Date.now() + 600_000;
  let draws: PalletDraw[];
  for (;;) {
    draws = await engine.draws(players[0].address, gameIndex);
    if (draws.length > 0 && draws.every((draw) => !DRAWING[draw.status])) break;
    if (Date.now() > until) throw new Error(`game ${gameIndex}'s draws have no winners within 10 min: ${draws.map((draw) => draw.status).join(", ") || "no draw"}`);
    await sleep(5_000);
  }
  const bots = new Map(players.map((player) => [Binary.toHex(player.publicKey), player]));
  const botOf = (holder: string | undefined) => (holder === undefined ? undefined : bots.get(Binary.toHex(AccountId().enc(holder))));
  const chain = fromPapi(client, api);
  const base = await api.constants.Game.airdrop_event_id_base();
  const result: DrawResult = { draws: draws.length, tickets: 0, winners: [], ineligible: {}, claimed: 0, claimFailures: {}, claimMs: new Histogram().summary(), prizeHeld: "0" };
  const claimMs = new Histogram();
  const winners = new Set<Player>();
  for (const draw of draws) {
    const holders = new Map(Object.entries(draw.holders ?? {}).map(([slot, holder]) => [slotKey(slot), holder]));
    result.tickets += [...holders.values()].filter((holder) => botOf(holder)).length;
    const won = draw.winningTickets.flatMap((slot) => {
      const bot = botOf(holders.get(slotKey(slot)));
      return bot ? [{ bot, slot: slotKey(slot) }] : [];
    });
    const eligible: typeof won = [];
    for (const [position, eligibility] of (await readAll(won, ({ bot }) => engine.eligibility(bot.address, gameIndex))).entries()) {
      if (eligibility.eligible) eligible.push(won[position]);
      else bump(result.ineligible, eligibility.reason ?? "unknown");
    }
    const signed = await pool.sign(
      eligible.map(({ bot }) => ({ player: bot, chain: "people" as const, signer: "participant" as const, tx: claimPrizeTx(chain, { gameIndex, airdropIndex: draw.airdropIndex, beneficiary: bot.address }) })),
      `prize claim ${draw.airdropIndex}`,
    );
    const burst = await submitBurst(signed, api, client, target.rpc, connections, () => Number.MAX_SAFE_INTEGER);
    claimMs.merge(burst.inclusionMs);
    for (const [failure, count] of Object.entries(burst.failures)) bump(result.claimFailures, failure, count);
    // A claim removes its winner from `Airdrop.Winners`.
    const eventId = gameAirdropEventId({ base, gameIndex, airdropIndex: draw.airdropIndex });
    const listed = new Set((await api.query.Airdrop.Winners.getEntries(eventId, { at: "best" })).map(({ value }) => slotKey(value)));
    result.claimed += won.filter(({ slot }) => !listed.has(slot)).length;
    for (const { bot } of won) {
      result.winners.push(bot.address);
      winners.add(bot);
    }
    console.log(`[draw] game ${gameIndex} draw ${draw.airdropIndex}: ${draw.status}, ${won.length} bots won of ${draw.winningTickets.length} winners`);
  }
  const balances = await readAll([...winners], (winner) => engine.prizeBalances(winner.address));
  result.claimMs = claimMs.summary();
  result.prizeHeld = balances.flat().reduce((sum, balance) => sum + BigInt(balance.amount), 0n).toString();
  return result;
}
