import { Enum, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { previewPeople } from "@pop-e2e/papi";
import { hostGhostPlayer } from "./keys.js";

const client = createClient(getWsProvider("wss://previewnet.substrate.dev/people"));
const api = client.getTypedApi(previewPeople);
const players = Array.from({ length: 1000 }, (_, index) => hostGhostPlayer("pop-e2e-load/previewnet", "dim2.testnet", 10, index));
const [game, now, rows, schedules] = await Promise.all([
  api.query.Game.Game.getValue({ at: "best" }),
  api.query.Timestamp.Now.getValue({ at: "best" }),
  api.query.Game.Players.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" }),
  api.query.Game.GameSchedules.getValue({ at: "best" }),
]);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19);
console.log(`chain time ${iso(Number(now) / 1000)} UTC`);
console.log(game ? `game ${game.index}: ${game.state.type}, plays ${iso(game.game_date)}, registration ends ${iso(game.registration_ends)}` : "no game running");
console.log(`next scheduled: ${schedules.slice(0, 3).map((schedule) => iso(schedule.game_play_time)).join(", ")}`);
console.log(`our bots registered: ${rows.filter((row) => row?.registered).length}/1000`);
process.exit(0);
