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
| `bots_per_machine` | bots one parity-large machine runs (default 1000); with `video`, 75 per 4-core `ubuntu-latest` machine instead |
| `video` | bots play H.264 video to their group over real WebRTC links (see [Video](#video)) |
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
  once. With `--draw` the bots get a VRF signer (the SDK's `localAirdropVrfSigner`) and enter the
  game's prize draws, as a phone does; without it they enter none. Lite bots also get personhood
  keys, below.
- **Lite people**: `truapi-host attest`, the host's own attestation through the stack's identity
  backend (DUB), as chain-tests runs it; it also registers the bot's lite username.
- **Lite sign-up**: a lite bot's personhood keys are the SDK's `PersonhoodProver`, answered with
  `verifiablejs` `one_shot` over its lite ring's members at the finalized block. The engine's `bind`
  (the SDK's `bindGameSeat`) binds the game account before the game opens, 50 at a time and the
  next 50 once those are in a block, since a block takes about 58 binds. `register` then takes the
  free route, `Game.sign_up_with_account_lite_invite`, and sends the revised leg itself when the
  ring's revision moved since the bind.
- **Prize claims**: the engine's `draws` and `eligibility` reads, and `Game.claim_airdrop` from the
  SDK's `claimPrizeTx`, signed as the score participant as the engine's `claimPrize` signs it.
- **Signer**: every People transaction of a bot carries its signature in `VerifyMultiSignature`,
  as a phone's host signs. The run builds and signs its bots' sign-ups, reports and claims on one
  worker thread per core: polkadot-api's signers decode the whole runtime metadata for every
  transaction, which on one thread takes about 0.6 s per sign-up on a CI runner.
- **Report**: each bot reads its seats through the engine (`playerIndices`, `groupMembers`) and the
  SDK's `groupSeats`, as the app's game view does, lays out the votes as the app's `buildReport`
  does, and builds `Game.report` with the SDK's `reportTx`, signed with `withScoreParticipant`
  as the engine's `report` signs it. `buildReport` lives in the app itself, under
  `apps/jollity-app/lib`, beside its UI, so the run repeats its few lines.
- **Game reads**: which game to join, its schedule and its roster come from the engine.
- **Credits**: the read the app's `readGameCredits` makes, `getClaims` of the nfts SDK, counted
  with `gameCredits` of `@individuality/game-outcome`, until they are claimable. Once every credit
  of an award block is claimed, Asset Hub deletes the block's tree, and the read then shows those
  credits as earned in no game. So a credit without a game counts only from the game's first
  report on, and which were claimed is read from Asset Hub's `NftClaims.ClaimedLeaves`.
- **NFT claims**: the Jollity app doesn't claim; the stash does, outside individuality-apps. Each
  credit goes to the collection the app's chest shows it in (`defaultCollectionFor` of
  `@jollity/collectables`, over the SDK's approved claimable collections), and the run builds
  `NftClaims.claim` itself, since no package of the app or the nfts SDK builds it.
- **Signalling**: the app's `statementTransport`, below.

The rest is the run's own, because the app doesn't do it: root's clearing, funding and scheduling
of a game and its phase durations and prize draw, funding the bots, and the timeline of game
states with their steps, read at the best block every second.

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
seal to each other without reading the chain. Every statement a bot's store accepts is due to
each of its co-players, which is how many deliveries a run expects. A bot has one statement per
channel, so a newer one can replace a statement before it reaches a co-player; it carries what the
replaced one did, so a co-player that receives a statement counts every earlier one of that channel
as delivered too. A receiver measures latency from when the statement went out when its sender
runs in the same process, and otherwise from the time its expiry was stamped with.

## Video

With `--video` (the workflow's `video` input) a bot opens real WebRTC peer connections in place of
the Chrome-sized descriptions, with [werift](https://github.com/shinyoshiaki/werift-webrtc), which
runs in Node and in the bun script inside truapi-host. Each link is set up as the app's mesh
(`lib/webrtc/mesh.ts`) sets it up:

- The lower account offers a data-channel-only description over the same statement transport, and
  candidates gathered after it trickle the same way. The app's `"data"` channel comes with it.
- Once the channel opens, the offerer adds video and sends a full-SDP offer down the channel's
  renegotiation lane (`encodeChannelMessage` and `PeerConnectionSignal` from statement-core); the
  answer comes back the same way.
- The camera goes to the first round's group from the room's opening. Co-players of the second
  round are linked during the pre-connect too, on standby (`replaceTrack(null)`); when the first
  round ends, the camera goes to the second round's group and links with no round left close.
- The camera is `media/clip.h264`: H.264 Constrained Baseline (`42e01f`, `packetization-mode=1`),
  360×360 at 24 fps, about 290 kbps, an IDR every 2 s, looped. The same packets go to every active
  link. A PLI, or the app's keyframe request on the channel, gets the clip's next IDR. `pnpm clip`
  writes the clip again with ffmpeg.
- A receiver counts packets, frames (marker bits), keyframes and sequence gaps without decoding,
  and sends a PLI when no keyframe has arrived since the camera came on or a loss persists.
- ICE uses the app's six STUN servers (`--stun` changes them, `--stun ""` uses none) and policy
  `all`; `--relay` allows relay candidates only.

**TURN.** `host --lite --video` plays lite bots, the ones `chain --lite` signs up, each in its own
truapi-host (each has its own wallet). Each fetches TURN credentials when the app does: as soon as
the run knows its game, then 10 and 3 minutes before it. The proof is `buildTurnProof` from
`@jollity/protocol` with the bot's lite key over its lite ring at People's finalized block, posted
to the network's issuer (`--turn-issuer`, default the stack's identity backend), with the app's up
to three tries. The runner proves and fetches for its machine's bots and gives each truapi-host
its bot's TURN servers. Without `--lite`, bots have STUN only.

A video bot sends and receives about 1.6 Mbit/s each way, so the workflow puts 75 on each 4-core
`ubuntu-latest` machine. The summary gets a **Video on …** table per layer:

- **Links up / attempted**: peer connections whose `"data"` channel opened; **With video**: those
  whose video renegotiation completed. Each link counts once per side.
- **Connect**: room open to the channel opening; **Candidate types**: the local candidate of each
  connected link's selected pair (`host`, `srflx`, `prflx`, `relay`).
- **First frame**: camera on (room open, or the second round's start) to the first whole keyframe.
- **Frames received / expected**: frames that arrived in the window against 24 per second of every
  stream's camera-on time after its video was negotiated. **Loss** is sequence gaps; **kbps per
  stream** is received payload over camera-on time.
- **PLI sent / received, IDRs forced**, and **TURN**: bots that had TURN servers when their room
  opened, every credential request by outcome (`ok`, or the issuer's cause and HTTP status), and
  the issuer's answer time.

A 500-bot video run on previewnet takes the lite bots made once with `load people --players 500`,
then the workflow with `network: previewnet`, `players: 500`, `video: true` and `args: --lite`:
7 `ubuntu-latest` machines.

Locally, 60 video bots on direct RPC against a previewnet fork's stack, STUN off and every link on
the loopback address (`--ice-address`). Without it each link binds a socket on every interface,
and on a Mac with VPN interfaces closing them at the end stalled the run for minutes:

```bash
export STACK=http://127.0.0.1:8090/.well-known/trinity-stack.json
pnpm load mint --players 60 --seed video-local
pnpm load signalling --video --stun "" --ice-address 127.0.0.1 --steps 60 --seed video-local \
  --ramp 5 --warmup 2 --drain 5 --cooldown 1
```

## Reading the results

The `chain` table has one row per burst: sign-up, report and NFT claim.

- **Succeeded** counts the transactions that executed; **In time** those in a block before the
  deadline: sign-ups before registration closed, reports within `--report-window` of the game.
- **Inclusion p50 / p95 / max ms** runs from submitting a transaction to its block.
- **Credits** shows how many of the credits People awarded the bots arrived on Asset Hub and how
  long that took, and how many were claimed on chain once every bot was done.
- **A player's claims** is the time one bot took for all of its claims, one after another.

**Blocks by phase** has one row per game state the People chain executed in: Registration (the
sign-up burst), Shuffle, Reporting (the report burst) and PlayerProcess. A block counts in the
state its previous block left the game in, so the block that ends a state counts with it. Blocks
before the run's game and after it don't count. The run reads every finalized block once, at its
hash.

- **Block time** is the time between consecutive blocks as the run's RPC node imported them. The
  chain's own timestamps can't give it: they follow the relay chain's slots, which consecutive
  blocks share.
- **Max normal %** is the normal-class weight over the normal-class limit, by ref time and proof
  size; **Max mandatory %** is the mandatory class over the block's limit, which on
  paseo-next-v2 includes the game's own processing.
- **Max KB** is the extrinsics' encoded size; **Max PoV KB**, on previewnet only, is the
  proof size the node reports with `dev_getBlockStats`.
- **Max unincluded** is `ParachainSystem.UnincludedSegment`: blocks the relay chain hasn't
  included yet.
- **Max credit trees** is the NFT credit trees waiting to be built, at most 8. A block builds one,
  so 8 waiting doesn't reject anything by itself: a report fails with `CreditCapacityExhausted`
  only when its credits don't fit the room left, and player processing waits while room is low.
- **Max finality lag** is how many blocks the best block was ahead when a block was finalized.
- **Collator 1 block ends**, on previewnet only, counts why building each block ended, from the
  collator's public log. When the log can't be read, the **Notes** list at the end says so, along
  with blocks or PoV sizes the run couldn't read.

**Game processing** shows the shuffle's work without its wait for the game date, the blocks from
the end of reporting to `GameEnded`, and the heaviest step. Where the runtime runs the game's steps
as calls, that is the step call's weight over the step budget, half the normal class's
`max_extrinsic`; otherwise it is the mandatory class's share of a block's ref time.

The run fails when `GameEnded` is later than the report end plus `player_process`, and a report
that fails with `CreditCapacityExhausted` is one of the report burst's failures. A **Capacity**
line under the findings lists blocks of a burst that took over twice the game's median block
time, blocks whose normal class reached 90%, and blocks after which 8 credit trees were waiting;
these don't fail the run.

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

## Lite bots and the prize draw

A lite bot plays the way a phone with a lite person does: it signs up free, without a deposit,
once its game account is bound to its lite person. Each lite bot has a wallet of its own, the one
truapi-host derives for host `<index>` with one ghost: its identity account (`peopl.<tld>` product
account 0) is the lite person, its game account (`dim2.<tld>` account 0) plays. Lite bots start at
index 100000 (`--lite-from`), far above the deposit-backed bots, whose hosts number in the
hundreds: a bot with a deposit-backed player record would keep signing up as a returning player.

`load people --players <n>` makes lite bots `--lite-from`..+n lite people the way a phone becomes
one: `truapi-host attest` with the bot's wallet, through DUB, which attests its identity account,
registers a lite username and waits until the lite key is a ring member. DUB names about 4.5
identities a minute (its dotNS lane writes 3 per Asset Hub batch) and truapi-host waits 2 min for
a name, so `--attest-concurrency` defaults to 3, and the run prints the time to expect: about 7 h
for 2,000 bots. An attest the CLI stopped waiting on counts as pending, since DUB still finishes
it; the run then reads the chain until every bot not refused is in a ring root. The summary gives
each attest's time, the pending ones, the 429s and the other failures by error. It reads which
bots are lite people already, so a rerun, also of an interrupted run, attests only the rest, and
nothing is stored: a lite bot's keys follow from `--seed`, the network
and its index alone, so the seed and the index range are all there is to keep. Changing the seed
makes new lite people, and a lite person can't be removed. truapi-host reaches DUB only through
`STACK` or `NETWORK`, so `people` takes `--rpc` only with `STACK`.

`load chain --lite` plays lite bots in place of the deposit-backed ones.

`load chain --draw` makes the prize draw part of the load: each bot enters the draws of whatever
game it signs up to as the app enters them, so a bot this game can't make a member (a new bot on
paseo, where membership takes 3 points, so 2 games) signs up without a ticket, and the summary
counts those as `not-member-yet`. After player processing each draw is read once, and each bot
that won claims its prize into its game account. The summary gives the entries, the tickets, the
bots that won, the claims with their inclusion time and failures. A game the run schedules as
root gets one draw (the chain's first
`Airdrop.SupportedAssets` asset at its minimum amount, 5 winners), for a fork whose games have
none; `Game.airdrops_scheduled` 0 there means `pop/gads`, the account the Game pallet pays prizes
from, lacks the prize asset.

```bash
cd packages/load-tests
STACK=http://127.0.0.1:8090/.well-known/trinity-stack.json pnpm load people --players 30
pnpm load chain --rpc ws://127.0.0.1:10010 --sudo //Alice --players 30 --lite --draw --take-over \
  --registration 150 --reporting 300
```

The ports are a previewnet fork's (`ppn start --fork` in previewnet-engine), where `//Alice` is
sudo and People builds lite rings and draws as it does live. The chain summary then has a line
for the binds and how many lite bots hold a deposit after signing up, and one for the draw's
tickets, winners and claims.

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
