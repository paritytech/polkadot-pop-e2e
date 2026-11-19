import type { PolkadotClient } from "polkadot-api";
import { mergeUint8 } from "@polkadot-api/utils";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import { claimPrizeTx, fromPapi } from "@parity/product-sdk-individuality";
import type { GameEngine, PalletDraw } from "@jollity/protocol/src/engine";
import { submitBurst } from "./burst.js";
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
  /** Bots that entered the draw with their sign-up. */
  tickets: number;
  /** The winning bots' game accounts. */
  winners: string[];
  /** Winners whose claim the chain would refuse, by the app's reason. */
  ineligible: Record<string, number>;
  claimed: number;
  /** Claims that failed, by error. */
  claimFailures: Record<string, number>;
  /** The prize asset the winners hold after their claims, in base units. */
  prizeHeld: string;
}

/** The airdrop event states before its winners are final. */
const DRAWING: Record<string, true> = { Scheduled: true, Registering: true, AwaitingEntropy: true, DrawWinners: true };

/**
 * Once draw 0 of game `gameIndex` has its winners, reads every bot's ticket and win, and each
 * winner the app would let claim claims its prize into its own game account with the SDK's
 * `claimPrizeTx`, signed as the score participant as the app signs it. Call it after the game's
 * player processing, which makes the winners eligible.
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
  for (;;) {
    const [draw] = await engine.draws(players[0].address, gameIndex);
    if (draw && !DRAWING[draw.status]) break;
    if (Date.now() > until) throw new Error(`draw 0 of game ${gameIndex} has no winners within 10 min: ${draw?.status ?? "no draw"}`);
    await sleep(5_000);
  }
  const drawOf = async (player: Player): Promise<PalletDraw | undefined> => (await engine.draws(player.address, gameIndex))[0];
  const draws = await readAll(players, drawOf);
  const winners = players.filter((_, position) => draws[position]?.won && !draws[position]?.claimed);
  console.log(`[draw] game ${gameIndex}: ${draws.filter((draw) => draw?.ticket).length} tickets, ${winners.length} winners, status ${draws[0]?.status}`);
  const ineligible: Record<string, number> = {};
  const eligible: Player[] = [];
  for (const [position, eligibility] of (await readAll(winners, (winner) => engine.eligibility(winner.address, gameIndex))).entries()) {
    if (eligibility.eligible) eligible.push(winners[position]);
    else bump(ineligible, eligibility.reason ?? "unknown");
  }
  const chain = fromPapi(client, api);
  const signed = await pool.sign(
    eligible.map((player) => ({ player, chain: "people" as const, signer: "participant" as const, tx: claimPrizeTx(chain, { gameIndex, airdropIndex: 0, beneficiary: player.address }) })),
    "prize claim",
  );
  const burst = await submitBurst(signed, api, client, target.rpc, connections, () => Number.MAX_SAFE_INTEGER);
  const after = await readAll(winners, drawOf);
  const balances = await readAll(winners, (winner) => engine.prizeBalances(winner.address));
  return {
    tickets: draws.filter((draw) => draw?.ticket).length,
    winners: winners.map((winner) => winner.address),
    ineligible,
    claimed: after.filter((draw) => draw?.claimed).length,
    claimFailures: burst.failures,
    prizeHeld: balances.flat().reduce((sum, balance) => sum + BigInt(balance.amount), 0n).toString(),
  };
}
