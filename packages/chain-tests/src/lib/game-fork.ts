/**
 * Fork-only Game setup: put the People chain's Game into a known state with one short game
 * that carries one prize draw, and put its phase durations back afterwards.
 *
 * Every change here is a root call, sent through the fork's //Alice sudo key. A live network
 * does not give that key, so only the fork-gated suite calls these.
 */
import { randomBytes } from "node:crypto";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { AccountId } from "polkadot-api";
import { getTxCreator } from "polkadot-api/tx-creator";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import { formatDispatchError, submitAndWatch } from "@parity/product-sdk-tx";
import type { PeopleApi } from "./client.js";

/** A built call the `Utility.batch_all` takes, as the People client types it. */
type BatchCall = Parameters<PeopleApi["tx"]["Utility"]["batch_all"]>[0]["calls"][number];
type GameCall = { decodedCall: BatchCall };

/** The asset key `Airdrop.SupportedAssets` and `Assets.Asset` are keyed by: an XCM location. */
type AssetId = Parameters<PeopleApi["query"]["Assets"]["Asset"]["getValue"]>[0];

/**
 * Every setup read is pinned to the best block. The finalized head trails it by 24 to 48 s on
 * these networks, which would put the schedule's timing and the batches' state out of step.
 */
const READ_AT = { at: "best" } as const;

/** `Game.set_game_phases` durations, in seconds. */
export interface GamePhases {
  registration: number;
  shuffle: number;
  post_shuffle_margin: number;
  reporting: number;
  player_process: number;
}

/**
 * Short phases, so a game runs through in a few minutes on a fork. Registration is long enough
 * for the sign-up and its draw wait, which must finish before registration closes.
 */
export const FORK_GAME_PHASES: GamePhases = {
  registration: 180,
  shuffle: 30,
  post_shuffle_margin: 30,
  reporting: 120,
  player_process: 60,
};

/**
 * Seconds from `Timestamp.Now` to the game's registration start. The chain opens a scheduled
 * game only while its registration start is still ahead, so this leaves room for the schedule
 * and the next block to land.
 */
const REGISTRATION_START_LEAD_S = 60;
/** A block, roughly: the pace the setup polls the chain at. */
const POLL_MS = 6_000;
const CLEAR_TIMEOUT_MS = 6 * 60_000;
const GAME_TIMEOUT_MS = 2 * 60_000;
const FUND_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 6 * 60_000;

/** The draw's prize: at least this many units, for one winner. */
const MIN_PRIZE_AMOUNT = 1_000_000n;
const DRAW_MAX_WINNERS = 1;
const DRAW_OFFSET_S = 120;
const DRAW_CLAIM_WINDOW_S = 3600;
const DRAW_WINNER_CAP = 1_000_000;

/** A game the setup has scheduled and seen open. */
export interface GameInfo {
  index: number;
  gamePlayTime: number;
  registrationEnds: number;
  airdropsScheduled: number;
}

/** The sr25519 account a test player signs with, and its VRF secret. */
export interface FreshAccount {
  address: string;
  publicKey: Uint8Array;
  /** The 64-byte expanded key, as `secretFromSeed` returns it. */
  secret: Uint8Array;
  signer: CommonSignerTxCreator;
}

/** The draw's prize, as checked against the chain's asset and the airdrop source. */
export interface DrawPrize {
  assetId: AssetId;
  amount: bigint;
  maxWinners: number;
}

/**
 * The phase durations in force now at the best block: the stored override, else the runtime
 * default. The default is a constant, which has no block to pin.
 */
export async function readPhases(api: PeopleApi): Promise<GamePhases> {
  return (
    (await api.query.Game.StoredPhaseDurations.getValue(READ_AT)) ??
    (await api.constants.Game.DefaultPhaseDurations())
  );
}

function samePhases(a: GamePhases | undefined, b: GamePhases): boolean {
  return (
    a !== undefined &&
    a.registration === b.registration &&
    a.shuffle === b.shuffle &&
    a.post_shuffle_margin === b.post_shuffle_margin &&
    a.reporting === b.reporting &&
    a.player_process === b.player_process
  );
}

async function readState(api: PeopleApi) {
  const [game, schedules, phases] = await Promise.all([
    api.query.Game.Game.getValue(READ_AT),
    api.query.Game.GameSchedules.getValue(READ_AT),
    api.query.Game.StoredPhaseDurations.getValue(READ_AT),
  ]);
  return { game, schedules, phases };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Checks that the fork's sudo key is the given account, before any root call is sent. Compares
 * public keys, so the SS58 prefix does not matter.
 */
export async function assertSudoKey(api: PeopleApi, sudoAddress: string): Promise<void> {
  const key = await api.query.Sudo.Key.getValue(READ_AT);
  if (!key) throw new Error("[game-fork] the chain has no sudo key: no root call can be sent");
  const a = AccountId().enc(key);
  const b = AccountId().enc(sudoAddress);
  if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) {
    throw new Error(
      `[game-fork] the sudo key is ${key}, not ${sudoAddress} (//Alice): ` +
        "the fork gate expects Alice to be sudo, so no root call was sent",
    );
  }
}

/**
 * Sends the calls as one `Utility.batch_all` inside one `Sudo.sudo`, and waits until the
 * block holds it. A failing inner call fails the whole batch, and the error names it.
 */
async function sudoBatch(
  api: PeopleApi,
  sudoSigner: CommonSignerTxCreator,
  calls: GameCall[],
  label: string,
): Promise<void> {
  const batch = api.tx.Utility.batch_all({ calls: calls.map((call) => call.decodedCall) });
  const result = await submitAndWatch(api.tx.Sudo.sudo({ call: batch.decodedCall }), sudoSigner, {
    waitFor: "best-block",
  });
  if (!result.ok) throw new Error(`[game-fork] ${label}: ${result.error.message}`);
  if (!result.value.ok) {
    throw new Error(`[game-fork] ${label}: ${formatDispatchError(result.value)}`);
  }
  // `TxResult.events` is untyped, so the Sudid filter takes it at this one boundary.
  const [sudid] = api.event.Sudo.Sudid.filter(
    result.value.events as Parameters<PeopleApi["event"]["Sudo"]["Sudid"]["filter"]>[0],
  );
  if (!sudid) throw new Error(`[game-fork] ${label}: the sudo call emitted no Sudid event`);
  const { sudo_result: sudoResult } = sudid.payload;
  if (!sudoResult.success) {
    const formatted = formatDispatchError({ ok: false, dispatchError: sudoResult.value });
    throw new Error(`[game-fork] ${label}: the root call failed: ${formatted}`);
  }
  console.log(`[game-fork] ${label}: included in #${result.value.block.number}`);
}

/**
 * Cancels the running game and drops every queued schedule, and sets the short phases,
 * until the Game is gone and nothing is queued. Each pass re-reads the chain, because the
 * chain can open a game between two reads.
 */
async function clearGames(
  api: PeopleApi,
  sudoSigner: CommonSignerTxCreator,
  target: GamePhases,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    const { game, schedules, phases } = await readState(api);
    const phase = game?.state.type;
    const calls: GameCall[] = [];
    // `set_game_phases` only works with no game, or a game in Registration.
    if (!samePhases(phases, target) && (!game || phase === "Registration")) {
      calls.push(api.tx.Game.set_game_phases({ phases: target }));
    }
    for (const schedule of schedules) {
      calls.push(api.tx.Game.remove_scheduled_game({ game_play_time: schedule.game_play_time }));
    }
    if (phase === "Registration" || phase === "Shuffle") {
      calls.push(api.tx.Game.cancel_game());
    } else if (phase === "Reporting") {
      calls.push(api.tx.Game.testnet_force_end_reporting());
    }

    if (calls.length > 0) {
      try {
        await sudoBatch(api, sudoSigner, calls, `clear (phase ${phase ?? "none"})`);
      } catch (error) {
        lastError = error;
      }
    } else if (!game && schedules.length === 0 && samePhases(phases, target)) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `[game-fork] the Game did not clear within ${timeoutMs} ms (phase ${phase ?? "none"}, ` +
          `${schedules.length} queued)${lastError ? `: ${String(lastError)}` : ""}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Reads the one prize the draw will pay, and checks the airdrop source can pay it.
 *
 * The asset is the first key of `Airdrop.SupportedAssets`. The amount is the asset's minimum
 * balance or `MIN_PRIZE_AMOUNT`, whichever is larger. The source is `Game.AirdropSource`, which
 * the chain pays the prize from, so it must hold `amount × maxWinners` of the asset.
 */
export async function readDrawPrize(api: PeopleApi): Promise<DrawPrize> {
  const [supported] = await api.query.Airdrop.SupportedAssets.getEntries(READ_AT);
  if (!supported) {
    throw new Error("[game-fork] Airdrop.SupportedAssets is empty: no asset can carry a draw");
  }
  const assetId = supported.keyArgs[0];

  const asset = await api.query.Assets.Asset.getValue(assetId, READ_AT);
  if (!asset) throw new Error("[game-fork] the supported draw asset is not in pallet Assets");
  const amount = asset.min_balance > MIN_PRIZE_AMOUNT ? asset.min_balance : MIN_PRIZE_AMOUNT;

  const source = await api.constants.Game.AirdropSource();
  const held = (await api.query.Assets.Account.getValue(assetId, source, READ_AT))?.balance ?? 0n;
  const needed = amount * BigInt(DRAW_MAX_WINNERS);
  if (held < needed) {
    throw new Error(
      `[game-fork] the airdrop source ${source} holds ${held} of the draw asset, ` +
        `short of the ${needed} one draw needs (${amount} × ${DRAW_MAX_WINNERS})`,
    );
  }
  return { assetId, amount, maxWinners: DRAW_MAX_WINNERS };
}

/** The error for a game that opened with no airdrop scheduled, naming the likely event. */
async function airdropScheduleFailure(api: PeopleApi, index: number): Promise<Error> {
  const events = await api.query.System.Events.getValue(READ_AT);
  const failed = api.event.Game.AirdropScheduleFailed.filter(events);
  const detail =
    failed.length > 0
      ? `the best block holds ${failed.length} AirdropScheduleFailed event(s): ${JSON.stringify(
          failed,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        )}`
      : "no AirdropScheduleFailed event is in the best block, so it may be in an earlier one";
  return new Error(
    `[game-fork] game ${index} opened with 0 airdrops scheduled: AirdropScheduleFailed is the ` +
      `likely cause (${detail})`,
  );
}

/**
 * Makes a game with one prize draw on the fork and waits until it is open for registration
 * with that draw scheduled.
 *
 * The prize is checked before anything is written. Then it clears any running or queued game,
 * sets the short phases, and queues one game whose registration starts about a minute ahead.
 * It polls until the chain opens that game.
 *
 * This removes the forked game's queued schedules and never restores them. Nothing that runs
 * after this file may depend on them.
 */
export async function prepareGameWithDraw(
  api: PeopleApi,
  sudoSigner: CommonSignerTxCreator,
): Promise<GameInfo> {
  const prize = await readDrawPrize(api);

  await clearGames(api, sudoSigner, FORK_GAME_PHASES, CLEAR_TIMEOUT_MS);

  // The game's play time: its registration starts `REGISTRATION_START_LEAD_S` ahead, then
  // runs through shuffle and the post-shuffle margin to play time.
  const now = Number((await api.query.Timestamp.Now.getValue(READ_AT)) / 1000n);
  const registrationStart = now + REGISTRATION_START_LEAD_S;
  const gamePlayTime =
    registrationStart +
    FORK_GAME_PHASES.registration +
    FORK_GAME_PHASES.shuffle +
    FORK_GAME_PHASES.post_shuffle_margin;

  await sudoBatch(
    api,
    sudoSigner,
    [
      api.tx.Game.schedule_games({
        games_schedules: [
          {
            game_play_time: gamePlayTime,
            rounds: 2,
            max_group_size: 6,
            airdrops: [
              {
                draw_offset: DRAW_OFFSET_S,
                claim_window: DRAW_CLAIM_WINDOW_S,
                prize: {
                  asset_id: prize.assetId,
                  asset_amount: prize.amount,
                  max_winners: prize.maxWinners,
                  winner_cap: DRAW_WINNER_CAP,
                },
              },
            ],
          },
        ],
      }),
    ],
    `schedule game ${gamePlayTime}`,
  );

  const deadline = Date.now() + GAME_TIMEOUT_MS;
  for (;;) {
    const { game, schedules } = await readState(api);
    if (game) {
      if (game.game_date !== gamePlayTime) {
        throw new Error(
          `[game-fork] the open game ${game.index} plays at ${game.game_date}, not ${gamePlayTime}: ` +
            "it is not the game this setup scheduled",
        );
      }
      if (game.airdrops_scheduled < 1) throw await airdropScheduleFailure(api, game.index);
      if (game.state.type !== "Registration") {
        throw new Error(
          `[game-fork] game ${game.index} opened in phase ${game.state.type}, not Registration`,
        );
      }
      console.log(
        `[game-fork] game ${game.index} open for registration with ${game.airdrops_scheduled} draw(s)`,
      );
      return {
        index: game.index,
        gamePlayTime,
        registrationEnds: game.registration_ends,
        airdropsScheduled: game.airdrops_scheduled,
      };
    }
    if (schedules.length === 0) {
      throw new Error(
        `[game-fork] the chain dropped the schedule for play time ${gamePlayTime} without opening ` +
          "it (OutdatedGameSetup?)",
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[game-fork] no game opened for play time ${gamePlayTime} within ${GAME_TIMEOUT_MS} ms`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Puts the phase durations back to `phases`. The chain only accepts that with no game, or a
 * game in Registration; for a game past that, this cancels it (Shuffle) or ends its reporting
 * (Reporting), and waits until the change is allowed.
 */
export async function restorePhases(
  api: PeopleApi,
  sudoSigner: CommonSignerTxCreator,
  phases: GamePhases,
  timeoutMs = RESTORE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    const { game, phases: stored } = await readState(api);
    if (samePhases(stored, phases)) return;

    const phase = game?.state.type;
    const calls: GameCall[] = [];
    if (!game || phase === "Registration") {
      calls.push(api.tx.Game.set_game_phases({ phases }));
    } else if (phase === "Shuffle") {
      calls.push(api.tx.Game.cancel_game());
    } else if (phase === "Reporting") {
      calls.push(api.tx.Game.testnet_force_end_reporting());
    }

    if (calls.length > 0) {
      try {
        await sudoBatch(api, sudoSigner, calls, `restore phases (phase ${phase ?? "none"})`);
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[game-fork] the phases did not restore within ${timeoutMs} ms (phase ${phase ?? "none"})` +
          (lastError ? `: ${String(lastError)}` : ""),
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * A fresh sr25519 account from a random seed. Its VRF secret is the same key, expanded, which
 * `localAirdropVrfSigner` takes.
 */
export function createFreshSr25519Account(): FreshAccount {
  const secret = secretFromSeed(randomBytes(32));
  const publicKey = getPublicKey(secret);
  return {
    address: AccountId().dec(publicKey),
    publicKey,
    secret,
    signer: getTxCreator(publicKey, "Sr25519", (message) => sign(secret, message)),
  };
}

/**
 * What a fresh player is funded with: three play deposits at the best block. The sign-up holds
 * one deposit and pays its fee from the rest, so this covers the deposit and the fee headroom.
 */
export async function playerFunding(api: PeopleApi): Promise<bigint> {
  const deposit = await api.query.Game.PlayDepositAmount.getValue(READ_AT);
  return 3n * deposit;
}

/**
 * Moves `amount` from the funder to `address` with `Balances.transfer_keep_alive`, then polls
 * the best block until the balance shows it.
 */
export async function fundAccount(
  api: PeopleApi,
  funder: CommonSignerTxCreator,
  address: string,
  amount: bigint,
): Promise<void> {
  const result = await submitAndWatch(
    api.tx.Balances.transfer_keep_alive({ dest: { type: "Id", value: address }, value: amount }),
    funder,
    { waitFor: "best-block" },
  );
  if (!result.ok) throw result.error;
  if (!result.value.ok) {
    throw new Error(`[game-fork] funding ${address} failed: ${formatDispatchError(result.value)}`);
  }

  const deadline = Date.now() + FUND_TIMEOUT_MS;
  for (;;) {
    const { data } = await api.query.System.Account.getValue(address, READ_AT);
    if (data.free >= amount) return;
    if (Date.now() > deadline) {
      throw new Error(
        `[game-fork] ${address} holds ${data.free} at the best block, short of the ${amount} sent`,
      );
    }
    await sleep(POLL_MS);
  }
}
