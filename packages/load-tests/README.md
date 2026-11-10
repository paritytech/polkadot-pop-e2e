# @pop-e2e/load-tests

Load shaped like the Jollity game, played against a People chain to find how many players it
carries and which part fails first. Three layers, each adding one piece of the real path:

| Layer | Players | What it loads | Where a limit shows |
|---|---|---|---|
| `signalling` | ghosts on direct People RPC, signing their own statements | statement store and RPC | delivery latency and loss, rejected or dropped connections, subscriptions the node ends, node submit time and CPU |
| `host` | ghosts inside `truapi-host signing-host --script`, `--ghosts-per-host` to a process | the same, through the host's proof, submit and per-subscription connections | the above, plus host CPU and memory per ghost |
| `chain` | funded accounts | one game: sudo schedules it, every player signs up at once, the chain shuffles, every player reports at once after the game | sign-ups after registration closed, a shuffle that ends in `Cancelling`, reports outside the report window, block fullness, dispatch and pool errors |

A signalling ghost behaves like a player's statement transport: it subscribes with
`matchAny: [inbox, room]` on one game-wide room topic, and submits a bundle on its own channel
every 8 s while a round's links are negotiated and every 16 s once they are up, with at most two
submits waiting. Every ghost receives every other ghost's bundle, so deliveries grow with the
square of the players. The bundle sizes come from a Chrome video and data-channel offer (about
4.9 KB of SDP, 1.7 KB of candidates), sealed for each of the 5 group peers; see `PROFILES` in
`src/profile.ts`.

Each bundle carries the time it was sent, so every receiver measures delivery latency, and the
accepted statements times `players - 1` is how many deliveries a step expects.

## Players

Players don't need a person, an alias or an attestation. For `signalling` and `host`, `mint`
writes each player's statement allowance as root (`System.set_storage` on
`:statement_allowance:<account>`, the 1,000,000 count / 1 MB a game sign-up grants). For
`chain`, each run derives fresh accounts and funds them with `Balances.force_set_balance`. Root
is `//Alice` on a PPN fork and `SUDO_URI` anywhere else.

## Running it

A step plays one game (151 s) with that many players, after a ramp over which they join and a
warmup; steps run one after the other. `--shard i/n` splits the players over processes or
machines that share `--start-at`; `summary` merges their result files.

On a local dev People node:

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

A dev node's chain clock does not follow the wall clock; the `chain` layer reads every deadline
from the chain, so set a long `--reporting` there.

The `host` layer needs `truapi-host` at the version `chain-tests` pins (or `TRUAPI_HOST_BIN`)
and `bun` on `PATH`. Against a stack the hosts get its endpoints; against a dev node, point
`HOST_CLI_LOCAL_NETWORK_CONFIG` at a [local network file](https://github.com/paritytech/trinity-user-agents/blob/main/docs/local-network.md)
that lists People, Asset Hub and Bulletin nodes.

Against a fork or a live network, set `STACK` or `NETWORK` as for the chain-tests and leave out
`--rpc`; `--rpc` then adds People endpoints to the stack's.

In CI, **Actions → Load test → Run workflow** forks previewnet or paseo-next-v2 on one runner
and plays the layer there, or plays it against the live network with one runner per process.
A live run needs the network's root key as `SUDO_URI` in the `load-<network>` environment, and
its `chain` layer cancels any scheduled game unless the operators have cleared the schedule.

## Reading the results

`summary.md` has one row per step:

- **Delivery p50 / p95 / p99** and **Lost** are what the players see; a step fails above 2 s at
  p95 or 1% lost.
- **Submit p95** is the `statement_submit` round trip. When it grows while **Node submit avg**
  (the statement store's own time) stays flat, the time goes to the RPC server or the path to it.
- **Node CPU cores** is the People node's CPU over the game; a node near its core count is the
  limit.
- **Client lag p99** is the load process's event-loop delay. Above 250 ms the step is
  `inconclusive`: the ghosts, not the target, fell behind, and more `--shard` processes are
  needed.
- **Findings** list what failed: rejected or dropped RPC connections (the node's
  `--rpc-max-connections`; 500 on a PPN fork), subscriptions the node ended (a subscriber that
  falls 128 statements behind is dropped), or submits the store rejected.

`summary.json` and the per-shard files contain the full counts, histograms and node metrics.
