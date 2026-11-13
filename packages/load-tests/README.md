# @pop-e2e/load-tests

Plays a real scheduled Jollity game on previewnet or paseo-next-v2 with N bots, to find how many
players a game carries and which part fails first: the People chain, its statement store, the RPC
path in front of it, or Asset Hub.

## Running it in CI

**Actions → Load test → Run workflow**, with `TEST_MNEMONIC` set as a repository secret:

| Input | What it sets |
|---|---|
| `network` | previewnet or paseo-next-v2 |
| `players` | bots in the game, up to 5000 |
| `bots_per_machine` | bots one parity-large machine runs (default 1000) |
| `signalling` | `co-players`, as the app does now (default), or `game`, the app before individuality-apps#1972 |
| `timing` | `sync`, the app's one shared re-send beat (default), or `random`, each bot on a beat of its own |
| `claim` | whether the bots claim their NFTs after the reports |
| `game_at` | the play time of the game to join; empty joins the closest scheduled one |
| `args` | more CLI options; changing `--ghosts-per-host` or `--seed` plays new, unfunded bots |

A run has three parts:

- **`chain`** waits for the game to open sign-ups, tops every bot up to 3 UNIT from
  `TEST_MNEMONIC`, signs them all up at once, sends every bot's report at once after the game, and
  claims the NFT credits its co-players' votes awarded it on Asset Hub, one claim at a time per bot
  as the stash app does. It fails at once when the game plays more than 4 hours away, and when the
  funder holds too little it says how much to send to which address. When it fails, it cancels the
  rest of the run.
- **`messages · machine N`**, one per `bots_per_machine` bots, waits until its bots are signed up,
  then runs them inside `truapi-host signing-host --script` from 64 s before the game, when the app
  opens its signalling, until the end of play.
- **`summary`** merges every machine's result into one table.

The bots are the same accounts from game to game on each network, so each pays its 2 UNIT play
deposit once. They don't need a person, an alias or an attestation: they sign up with
`Game.sign_up_with_account`, share groups with the game's real players, and vote `Person` for
every co-player. They never join the video call, so to a real player they are seats that don't
connect.

Two limits outside the test decide what a run can show:

- previewnet's People node accepts 500 RPC connections in total (HTTP 429 beyond) and a bot needs
  about one, so a previewnet run above about 400 bots measures that limit:
  https://github.com/paritytech/preview-net-v1/issues/191;
- paseo-next-v2's People and Asset Hub RPC share a 1 Gbps load balancer with the Polkadot and
  Kusama public RPC, and 1,000 bots already brought it close to that limit:
  https://github.com/paritytech/devops/issues/5868.

## How a bot signals

A bot behaves like a player's statement transport in the Jollity app since individuality-apps#1972:
it posts its bundle under a topic of its own and subscribes to the topics of its co-players, the
10 players it shares a table with over two rounds of 6, so a bundle reaches only them. A bundle
with offers in it goes deflated, about 45% smaller, as the app sends it. `signalling: game` plays
the app before #1972: one room topic every bot posts under and subscribes to, so every bot
receives every bundle and deliveries grow with the square of the players.

Every bot opens its subscription at the same instant, 64 s before the first round (the
pre-connect), negotiates every co-player of every round then, and re-sends on one beat from that
instant: every 8 s while links are negotiated, every 16 s once they are up, with at most two
submits waiting. A game's re-sends therefore land in the same second; `timing: random` gives each
bot its own beat instead.

The bundle sizes come from Chrome's data-channel-only offer (about 1 KB of SDP, 1.7 KB of
candidates), sealed for each of the 10 co-players; the store carries only that first
negotiation, and the video offer goes down the data channel. See `PROFILES` in `src/profile.ts`.
Each bundle carries the time it was sent, so every receiver measures delivery latency, and each
sender counts how many bots listen on its topic, which is how many deliveries a run expects.

## Reading the results

The `chain` table has one row per burst: sign-up, report and NFT claim.

- **Succeeded** counts the transactions that executed; **In time** those in a block before the
  deadline: sign-ups before registration closed, reports within `--report-window` of the game.
- **Inclusion p50 / p95 / max ms** runs from submitting a transaction to its block.
- **Credits** says how many of the credits People awarded the bots reached Asset Hub and how long
  that took, and how many were claimed on chain once every bot was done.
- **A player's claims** is the time one bot took for all of its claims, one after another.
- **Fullest block** is the fullest People block of the game, by weight and proof size.

The messages table has one row per run:

- **Delivery p50 / p95 / p99** and **Lost** are what the players see; the run fails above 2 s at
  p95 or 1% lost.
- **Submit p95** is the `statement_submit` round trip through truapi-host.
- **Host CPU / RSS per ghost** is what a bot costs its machine.
- **Client lag p99** is a load process's event-loop delay. Above 250 ms, or when a machine sent no
  result or started late, the verdict is `inconclusive`: the load, not the target, fell behind.
- **Node submit avg** and **Node CPU cores** need `--metrics` with the People nodes' Prometheus
  endpoints, which a live network doesn't expose; they show `–` in CI.
- **Findings** list what failed: rejected or dropped connections, subscriptions the node ended (a
  subscriber that falls 128 statements behind is dropped), submits not accepted.

`summary.json` and the per-machine files contain the full counts and histograms.

## Running it locally

Against a live network, set `NETWORK` as for the chain-tests, and `TEST_MNEMONIC`:

```bash
cd packages/load-tests
NETWORK=paseo-next-v2 pnpm load chain --players 300
NETWORK=paseo-next-v2 pnpm load host --follow-game --steps 300
```

The `host` command needs `truapi-host` at the version `chain-tests` pins (or `TRUAPI_HOST_BIN`) and
`bun` on `PATH`.

On a dev People node, a root key (`//Alice`) stands in for the sign-ups: `mint` writes each
player's statement allowance (`System.set_storage` on `:statement_allowance:<account>`, the
1,000,000 count / 1 MB a game sign-up grants), and `chain` funds fresh accounts and schedules its
own short game, after clearing the chain's game and schedule with `--take-over`. The `signalling`
command runs bots that sign their own statements over direct RPC, without truapi-host, and `--steps`
plays one game per player count:

```bash
B=path/to/previewnet-engine/bin
$B/chain-spec-builder -c /tmp/people.json create --relay-chain paseo-local --para-id 1502 \
  -r $B/next_people_paseo_runtime.wasm named-preset development
$B/polkadot-omni-node --chain /tmp/people.json --dev-block-time 2000 --tmp --enable-statement-store \
  --rpc-max-connections 10000 --prometheus-port 9615

cd packages/load-tests
pnpm load mint --rpc ws://127.0.0.1:9944 --sudo //Alice --players 500
pnpm load signalling --rpc ws://127.0.0.1:9944 --metrics http://127.0.0.1:9615/metrics --steps 50,100,250,500
pnpm load chain --rpc ws://127.0.0.1:9944 --sudo //Alice --players 300 --registration 120 --reporting 1500
```

A dev node's chain clock does not follow the wall clock; the `chain` command reads every deadline
from the chain, so set a long `--reporting` there. For `host` against a dev node, point
`HOST_CLI_LOCAL_NETWORK_CONFIG` at a [local network file](https://github.com/paritytech/trinity-user-agents/blob/main/docs/local-network.md)
that lists People, Asset Hub and Bulletin nodes. `--shard i/n` splits the bots over processes or
machines that share `--start-at`, and `summary` merges their result files.
