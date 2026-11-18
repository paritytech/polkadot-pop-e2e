# @pop-e2e/load-tests

Plays a real scheduled Jollity game on previewnet or paseo-next-v2 with N bots, or replays one
game's messages without a game, to find how many players a game carries and which part fails
first: the People chain, its statement store, the RPC path or light-client peers in front of it,
or Asset Hub.

## Running it in CI

**Actions → Load test → Run workflow**, with `TEST_MNEMONIC` set as a repository secret:

| Input | What it sets |
|---|---|
| `network` | previewnet or paseo-next-v2 |
| `players` | bots in the game, up to 5000 |
| `bots_per_machine` | bots one parity-large machine runs (default 1000) |
| `timing` | `sync`, every bot opening its room at the same instant as the app does (default), or `random`, each up to one heartbeat later |
| `claim` | whether the bots claim their NFTs after the reports |
| `game_at` | the play time of the game to join; empty joins the closest scheduled one |
| `replay_at` | a start time: the bots of an earlier game exchange the same messages then, without a game, sign-up, reports or claims |
| `chain_backend` | how the bots' truapi-host connects to People: `rpc` (default) or `light-client`, its embedded smoldot |
| `host_log` | truapi-host's log level; `debug` records why each connection ended |
| `args` | more CLI options; changing `--ghosts-per-host` or `--seed` plays new, unfunded bots; `--bots-per-process 1` runs every bot in its own truapi-host, as on a phone |

A run has three parts:

- **`chain`** waits for the game to open sign-ups, tops every bot up to 3 UNIT from
  `TEST_MNEMONIC`, signs them all up at once, sends every bot's report at once after the game, and
  claims the NFT credits its co-players' votes awarded it on Asset Hub, one claim at a time per bot
  as the stash app does. It fails at once when the game plays more than 4 hours away, and when the
  funder has too little it prints how much to send to which address. When it fails, it cancels the
  rest of the run.
- **`messages · machine N`**, one per `bots_per_machine` bots, waits until its bots are signed up,
  then runs them inside `truapi-host signing-host --script` from 64 s before the game, when the app
  opens its signalling, until the end of play.
- **`summary`** merges every machine's result into one table.

The bots are the same accounts from game to game on each network, so each pays its 2 UNIT play
deposit once. They don't need a person, an alias or an attestation: the app's sign-up takes
`Game.sign_up_with_account` for a player without personhood, they share groups with the game's
real players, and they vote `Person` for every co-player. They never join the video call, so to a
real player they are seats that don't connect.

A bot that misses games loses score; at 0 the chain archives it and removes its statement
allowance, so a replay needs bots that played a recent game. A game run signs them up again.

Two limits outside the test decide what a run can show:

- previewnet's People node accepts 500 RPC connections in total (HTTP 429 beyond) and a bot needs
  about one, so a previewnet run above about 400 bots measures that limit:
  https://github.com/paritytech/preview-net-v1/issues/191
- paseo-next-v2's collators take about 500 light clients at once, each client taking a slot on
  every collator, so a light-client run above that measures this limit:
  https://github.com/paritytech/devops/issues/5871

## What runs the app's code

The bots run the Jollity app's own packages from
[individuality-apps](https://github.com/paritytech/individuality-apps/tree/2560663a232cb710b10b7f5417fc300cd830efbe)
wherever the app does something a bot can do. Those packages aren't published and depend on each
other by name, so the root `package.json` maps each of them, through `pnpm.overrides`, to its
directory at one pinned commit, and `@pop-e2e/load-tests` depends on them as `*`. Moving the pin
means changing the commit in those overrides.

- **Sign-up**: `register` of the app's chain engine (`@jollity/game-chain`), the sign-up the app's
  flow calls, over the SDK's `registerForGame`. For an account without personhood it reads the
  seat and builds `Game.sign_up_with_account`, signed plainly for a new player and as the score
  participant for a returning one. Its `submit` only signs, so the run still sends every sign-up at
  once. The bots get no VRF signer, so they enter no prize draw.
- **Signer**: every People transaction of a bot carries its signature in `VerifyMultiSignature`,
  as a phone's host signs.
- **Report**: each bot reads its seats through the engine (`playerIndices`, `groupMembers`) and the
  SDK's `groupSeats`, as the app's game view does, lays out the votes as the app's `buildReport`
  does, and builds `Game.report` with the SDK's `reportTx`, signed with `withScoreParticipant`
  as the engine's `report` signs it. `buildReport` lives in the app itself, under
  `apps/jollity-app/lib`, beside its UI, so the run repeats its few lines.
- **Game reads**: which game to join, its schedule and its roster come from the engine.
- **Credits**: `readGameCredits` of `@individuality/game-outcome`, the app's count of a game's
  credits, until they are claimable. Which were claimed is read from Asset Hub's
  `NftClaims.ClaimedLeaves`: once every credit of an award block is claimed, Asset Hub deletes the
  block's tree, and the app's read then shows those credits as earned in no game.
- **NFT claims**: the Jollity app doesn't claim; the stash does, outside individuality-apps. Each
  credit goes to the collection the app's chest shows it in (`defaultCollectionFor` of
  `@jollity/collectables`, over the SDK's approved claimable collections), and the run builds
  `NftClaims.claim` itself, since no package of the app or the nfts SDK builds it.
- **Signalling**: the app's `statementTransport`, below.

The rest is the run's own, because the app doesn't do it: root's clearing, funding and scheduling
of a game and its phase durations, funding the bots, and the timeline of game states with their
steps, read at the best block every second.

## How a bot signals

A bot runs the Jollity app's own signalling: `statementTransport` from
[`@jollity/statement-core`](https://github.com/paritytech/individuality-apps/tree/2560663a232cb710b10b7f5417fc300cd830efbe/packages/jollity-statement-core),
which the root `package.json` pins to a commit of individuality-apps, configured as the app's game source
configures it. Each bot keeps one statement live, a bundle under a topic of its own, deflated once it
carries more than a hello; every offer and candidate in it is sealed to the co-player's
communication key; a statement signed by another account than the one it names is dropped. A bot
listens to its co-players' topics alone, the 10 players it shares a table with over two rounds of
6, and calibrates its store clock with one statement before its room opens, as the waiting room
does.

In place of WebRTC, a bot plays the app's mesh for that room. Every bot opens its room at the same
instant, 64 s before the first round (the pre-connect), and negotiates every co-player of every
round then: the lower account offers and the other answers, each with a Chrome data-channel-only
description (about 1 KB of SDP) and 8 trickled candidates (about 1.7 KB of JSON), 750 ms after the
step that starts it, the time the app gathers for. A link counts as up once a bot has sent its
description and received the co-player's description and candidates, and the bot then tells the
transport so, as the app does when a connection connects. What is re-sent and when is the
transport's own: its heartbeat every 8 s while a link negotiates, a hello every 16 s once every
link is up. `timing: random` opens each bot's room up to 8 s later instead.

The app no longer has a room that every phone of a game posts to and listens on, so the bots no
longer have one either.

Bots signal under their run's own namespace, so they never reach real players. A bot's
communication key derives from its account, and so does the identifier it signs up with, so bots
seal to each other without reading the chain. Each statement's expiry carries the time it was
stamped, so every receiver measures delivery latency from it, and every statement a bot's store
accepts is due to each of its co-players, which is how many deliveries a run expects.

## Reading the results

The `chain` table has one row per burst: sign-up, report and NFT claim.

- **Succeeded** counts the transactions that executed; **In time** those in a block before the
  deadline: sign-ups before registration closed, reports within `--report-window` of the game.
- **Inclusion p50 / p95 / max ms** runs from submitting a transaction to its block.
- **Credits** shows how many of the credits People awarded the bots arrived on Asset Hub and how
  long that took, and how many were claimed on chain once every bot was done.
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
  subscriber that falls 128 statements behind is dropped), submits not accepted, links not up when
  the game ended, truapi-host processes that exited with an error.

`summary.json` and the per-machine files contain the full counts and histograms.

## Running it locally

Against a live network, set `NETWORK` (or `STACK`) as for the chain-tests, and `TEST_MNEMONIC`:

```bash
cd packages/load-tests
NETWORK=paseo-next-v2 pnpm load chain --players 300
NETWORK=paseo-next-v2 pnpm load host --follow-game --steps 300
NETWORK=paseo-next-v2 pnpm load host --steps 1000 --start-at 2026-11-20T10:00:00Z
```

The last one replays a game's messages without a game; it needs bots that signed up to a recent
game and so have a statement allowance. The `host` command needs `truapi-host` at the version
`chain-tests` pins (or `TRUAPI_HOST_BIN`) and `bun` on `PATH`; `TRUAPI_CHAIN_BACKEND=light-client`
runs it on its light client, on a built-in network only, without `STACK`.

On a dev People node, a root key (`//Alice`) stands in for the sign-ups: `mint` writes each
player's statement allowance (`System.set_storage` on `:statement_allowance:<account>`, the
1,000,000 count / 1 MB a game sign-up grants), and `chain` funds fresh accounts and schedules its
own short game, after clearing the chain's game and schedule with `--take-over`. The `signalling`
command runs bots that sign their own statements over direct RPC, without truapi-host, and `--steps`
plays one game per player count:

```bash
BIN=path/to/previewnet-engine/bin
$BIN/chain-spec-builder -c /tmp/people.json create --relay-chain paseo-local --para-id 1502 \
  -r $BIN/next_people_paseo_runtime.wasm named-preset development
$BIN/polkadot-omni-node --chain /tmp/people.json --dev-block-time 2000 --tmp --enable-statement-store \
  --rpc-max-connections 10000 --prometheus-port 9615

cd packages/load-tests
pnpm load mint --rpc ws://127.0.0.1:9944 --sudo //Alice --players 500
pnpm load signalling --rpc ws://127.0.0.1:9944 --metrics http://127.0.0.1:9615/metrics --steps 50,100,250,500
pnpm load chain --rpc ws://127.0.0.1:9944 --sudo //Alice --players 300 --registration 120 --reporting 1500
```

A dev node's chain clock does not follow the wall clock; the `chain` command reads every deadline
from the chain, so set a long `--reporting` there. With `--rpc` alone the run reads the chain
through previewnet's descriptors; when the node's runtime differs from previewnet's, reads fail
with `Incompatible runtime entry`, and `--network paseo-next-v2` picks that network's descriptors.
`host` doesn't take `--rpc`: truapi-host connects to chains only through a stack descriptor, so
run it with `STACK` or `NETWORK`.
`--shard i/n` splits the bots over processes or machines that share `--start-at`, and `summary`
merges their result files.

## How many light clients a node takes

`pnpm light-slots <in-peers-light> <nodes> <clients>` starts a local dev chain of 1 to 6
`polkadot` nodes from `PATH`, each with that `--in-peers-light` and listed as a bootnode, connects
that many light clients, each its own smoldot, and prints how many got a peer and how many peers
each has:

```bash
pnpm --filter @pop-e2e/load-tests light-slots 50 2 80
```
