/**
 * Fork-only Game setup: puts the People chain's Game into a known state with one short game
 * that carries one prize draw, and restores its phase durations afterwards. Every change is a
 * root call sent with the fork's //Alice sudo key, so only the fork-gated suite calls these.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { AccountId } from "polkadot-api";
import { formatDispatchError, submitAndWatch } from "@parity/product-sdk-tx";
import type { PeopleApi } from "./client.js";
import { POLL_MS, READ_AT, sleep } from "./fork-account.js";

/** A call the `Utility.batch_all` takes, and the transaction that builds it. */
type Call = Parameters<PeopleApi["tx"]["Utility"]["batch_all"]>[0]["calls"][number];
type Tx = { decodedCall: Call };

/** `Game.set_game_phases` durations, in seconds. */
export interface GamePhases {
  registration: number;
  shuffle: number;
  post_shuffle_margin: number;
  reporting: number;
  player_process: number;
}

const PHASE_KEYS = [
  "registration",
  "shuffle",
  "post_shuffle_margin",
  "reporting",
  "player_process",
] as const;

/** Short phases, so a game runs in a few minutes. Registration covers the sign-up's draw wait. */
const FORK_PHASES: GamePhases = {
  registration: 180,
  shuffle: 30,
  post_shuffle_margin: 30,
  reporting: 120,
  player_process: 60,
};

/** Seconds from now to registration start, so the schedule lands while registration is ahead. */
const REGISTRATION_LEAD_S = 60;
/** The prize is at least this many units, and pays one winner. */
const MIN_PRIZE = 1_000_000n;
const CLEAR_TIMEOUT_MS = 6 * 60_000;
const GAME_TIMEOUT_MS = 2 * 60_000;
const RESTORE_TIMEOUT_MS = 6 * 60_000;

/** A game the setup has scheduled and seen open. */
export interface GameInfo {
  index: number;
  airdropsScheduled: number;
}

/** The phase durations in force at the best block: the stored override, else the default. */
export async function readPhases(api: PeopleApi): Promise<GamePhases> {
  return (
    (await api.query.Game.StoredPhaseDurations.getValue(READ_AT)) ??
    (await api.constants.Game.DefaultPhaseDurations())
  );
}

function samePhases(stored: GamePhases | undefined, wanted: GamePhases): boolean {
  return stored !== undefined && PHASE_KEYS.every((key) => stored[key] === wanted[key]);
}

async function readState(api: PeopleApi) {
  const [game, schedules, phases] = await Promise.all([
    api.query.Game.Game.getValue(READ_AT),
    api.query.Game.GameSchedules.getValue(READ_AT),
    api.query.Game.StoredPhaseDurations.getValue(READ_AT),
  ]);
  return { game, schedules, phases };
}

/**
 * Checks the fork's sudo key is `sudoAddress` before any root call. Compares public keys, so
 * the SS58 prefix does not matter.
 */
export async function assertSudoKey(api: PeopleApi, sudoAddress: string): Promise<void> {
  const key = await api.query.Sudo.Key.getValue(READ_AT);
  if (!key) throw new Error("the chain has no sudo key, so no root call can be sent");
  if (!Buffer.from(AccountId().enc(key)).equals(AccountId().enc(sudoAddress))) {
    throw new Error(`the sudo key is ${key}, not ${sudoAddress} (//Alice): no root call was sent`);
  }
}

/**
 * Sends the calls as one `Utility.batch_all` inside `Sudo.sudo`, and waits until the best block
 * holds it. A failing inner call fails the batch, and the error says which.
 */
export async function sudoBatch(
  api: PeopleApi,
  signer: CommonSignerTxCreator,
  calls: Tx[],
  label: string,
): Promise<void> {
  const batch = api.tx.Utility.batch_all({ calls: calls.map((call) => call.decodedCall) });
  const result = await submitAndWatch(api.tx.Sudo.sudo({ call: batch.decodedCall }), signer, {
    waitFor: "best-block",
  });
  if (!result.ok) throw new Error(`${label}: ${result.error.message}`);
  if (!result.value.ok) throw new Error(`${label}: ${formatDispatchError(result.value)}`);
  // `TxResult.events` is untyped, so the Sudid filter takes it at this one boundary.
  const [sudid] = api.event.Sudo.Sudid.filter(
    result.value.events as Parameters<PeopleApi["event"]["Sudo"]["Sudid"]["filter"]>[0],
  );
  if (!sudid) throw new Error(`${label}: the sudo call emitted no Sudid event`);
  const { sudo_result: sudoResult } = sudid.payload;
  if (!sudoResult.success) {
    const failure = formatDispatchError({ ok: false, dispatchError: sudoResult.value });
    throw new Error(`${label}: the root call failed: ${failure}`);
  }
  console.log(`[game-fork] ${label}: included in #${result.value.block.number}`);
}

/**
 * Cancels the running game, drops every queued schedule and sets `phases`, until the Game is
 * gone and nothing is queued. Each pass re-reads the chain, because the chain can open a game
 * between two reads.
 */
export async function clearGames(
  api: PeopleApi,
  signer: CommonSignerTxCreator,
  phases: GamePhases = FORK_PHASES,
): Promise<void> {
  const deadline = Date.now() + CLEAR_TIMEOUT_MS;
  let lastError: unknown;
  for (;;) {
    const { game, schedules, phases: stored } = await readState(api);
    const phase = game?.state.type;
    const calls: Tx[] = [];
    // `set_game_phases` only works with no game, or a game in Registration.
    if (!samePhases(stored, phases) && (!game || phase === "Registration")) {
      calls.push(api.tx.Game.set_game_phases({ phases }));
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
        await sudoBatch(api, signer, calls, `clear (phase ${phase ?? "none"})`);
      } catch (error) {
        lastError = error;
      }
    } else if (!game && schedules.length === 0 && samePhases(stored, phases)) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the Game did not clear within ${CLEAR_TIMEOUT_MS} ms (phase ${phase ?? "none"}, ` +
          `${schedules.length} queued)${lastError ? `: ${String(lastError)}` : ""}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Makes a game with one prize draw on the fork, and waits until the chain opens it for
 * registration with that draw scheduled.
 *
 * The prize is checked before anything is written: the draw asset is the first entry of
 * `Airdrop.SupportedAssets` that the airdrop source (`Game.AirdropSource`) holds enough of. Then the
 * running game and every queued schedule are cleared, and one game is queued. This drops the
 * forked game's queued schedules and never restores them, so nothing after this may need them.
 */
export async function prepareGameWithDraw(
  api: PeopleApi,
  signer: CommonSignerTxCreator,
): Promise<GameInfo> {
  const source = await api.constants.Game.AirdropSource();
  const supported = await api.query.Airdrop.SupportedAssets.getEntries(READ_AT);
  let prize: { assetId: (typeof supported)[number]["keyArgs"][0]; amount: bigint } | undefined;
  for (const { keyArgs: [assetId] } of supported) {
    const asset = await api.query.Assets.Asset.getValue(assetId, READ_AT);
    if (!asset) continue;
    const amount = asset.min_balance > MIN_PRIZE ? asset.min_balance : MIN_PRIZE;
    const account = await api.query.Assets.Account.getValue(assetId, source, READ_AT);
    if ((account?.balance ?? 0n) >= amount) {
      prize = { assetId, amount };
      break;
    }
  }
  if (!prize) {
    throw new Error(
      `the airdrop source ${source} cannot fund a prize in any of the ` +
        `${supported.length} Airdrop.SupportedAssets`,
    );
  }
  const { assetId, amount } = prize;

  await clearGames(api, signer);

  // Registration starts `REGISTRATION_LEAD_S` ahead; play time is after registration, shuffle
  // and the post-shuffle margin.
  const now = Number((await api.query.Timestamp.Now.getValue(READ_AT)) / 1000n);
  const { registration, shuffle, post_shuffle_margin: margin } = FORK_PHASES;
  const gamePlayTime = now + REGISTRATION_LEAD_S + registration + shuffle + margin;

  await sudoBatch(
    api,
    signer,
    [
      api.tx.Game.schedule_games({
        games_schedules: [
          {
            game_play_time: gamePlayTime,
            rounds: 2,
            max_group_size: 6,
            tenure_claim_window: 0,
            airdrops: [
              {
                draw_offset: 120,
                claim_window: 3600,
                prize: {
                  asset_id: assetId,
                  asset_amount: amount,
                  max_winners: 1,
                  winner_cap: 1_000_000,
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
          `the open game ${game.index} plays at ${game.game_date}, not ${gamePlayTime}`,
        );
      }
      if (game.airdrops_scheduled < 1) {
        const events = await api.query.System.Events.getValue(READ_AT);
        const failed = api.event.Game.AirdropScheduleFailed.filter(events);
        const json = JSON.stringify(failed, (_key, value) =>
          typeof value === "bigint" ? `${value}` : value,
        );
        throw new Error(
          `game ${game.index} opened with 0 draws; AirdropScheduleFailed in the best block: ` +
            (failed.length > 0 ? json : "none (it may be in an earlier block)"),
        );
      }
      if (game.state.type !== "Registration") {
        throw new Error(`game ${game.index} opened in phase ${game.state.type}, not Registration`);
      }
      console.log(
        `[game-fork] game ${game.index} open for registration with ${game.airdrops_scheduled} draws`,
      );
      return { index: game.index, airdropsScheduled: game.airdrops_scheduled };
    }
    if (schedules.length === 0) {
      throw new Error(
        `the chain dropped the schedule for ${gamePlayTime} without opening it ` +
          "(OutdatedGameSetup?)",
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`no game opened for play time ${gamePlayTime} within ${GAME_TIMEOUT_MS} ms`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * Puts the phase durations back to `phases`. The chain accepts that only with no game, or a game
 * in Registration. For a later game this cancels it (Shuffle) or ends its reporting, and it waits
 * until the change is allowed.
 */
export async function restorePhases(
  api: PeopleApi,
  signer: CommonSignerTxCreator,
  phases: GamePhases,
): Promise<void> {
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  let lastError: unknown;
  for (;;) {
    const { game, phases: stored } = await readState(api);
    if (samePhases(stored, phases)) return;

    const phase = game?.state.type;
    const calls: Tx[] = [];
    if (!game || phase === "Registration") {
      calls.push(api.tx.Game.set_game_phases({ phases }));
    } else if (phase === "Shuffle") {
      calls.push(api.tx.Game.cancel_game());
    } else if (phase === "Reporting") {
      calls.push(api.tx.Game.testnet_force_end_reporting());
    }

    if (calls.length > 0) {
      try {
        await sudoBatch(api, signer, calls, `restore phases (phase ${phase ?? "none"})`);
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the phases did not restore within ${RESTORE_TIMEOUT_MS} ms (phase ${phase ?? "none"})` +
          (lastError ? `: ${String(lastError)}` : ""),
      );
    }
    await sleep(POLL_MS);
  }
}
