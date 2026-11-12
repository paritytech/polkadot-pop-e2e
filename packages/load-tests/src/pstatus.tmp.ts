import { Enum, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseoNextPeople } from "@pop-e2e/papi";
import { hostGhostPlayer } from "./keys.js";

const client = createClient(getWsProvider("wss://paseo-people-next-system-rpc.polkadot.io"));
const api = client.getTypedApi(paseoNextPeople);
const players = Array.from({ length: 2000 }, (_, index) => hostGhostPlayer("pop-e2e-load/paseo-next-v2", "dim2.paseo", 10, index));
const [game, now, rows, funder, sample] = await Promise.all([
  api.query.Game.Game.getValue({ at: "best" }),
  api.query.Timestamp.Now.getValue({ at: "best" }),
  api.query.Game.Players.getValues(players.map((player) => [Enum("Account", player.address)]), { at: "best" }),
  api.query.System.Account.getValue("5F6cvApy61MyCGsSqUcNi5coE8qhtU9sKBhzAW65ejWe1Y2Q", { at: "best" }),
  api.query.System.Account.getValue(players[1999].address, { at: "best" }),
]);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19);
console.log(`chain time ${iso(Number(now) / 1000)} UTC`);
console.log(game ? `game ${game.index}: ${game.state.type}, plays ${iso(game.game_date)}, registration ends ${iso(game.registration_ends)}` : "no game running");
console.log(`funder: nonce ${funder.nonce}, ${(Number(funder.data.free) / 1e10).toFixed(1)} PAS; bot 1999: ${(Number(sample.data.free) / 1e10).toFixed(2)} PAS`);
console.log(`our bots registered: ${rows.filter((row) => row?.registered).length}/2000`);
process.exit(0);
