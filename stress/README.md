# Stress flood

`.github/workflows/stress-flood.yml` floods People on a fresh fork of previewnet with
proof-authorized statement claims and measures where the chain degrades. It runs
[Polkameter](https://github.com/agustinustheo/polkameter), a chain-agnostic load engine, with
the People plugin in this directory, driven by an XML plan in [`plans/`](plans). It replaces the
standalone Rust `stress` tool proposed in #37.

One run: recognize people with sudo, wait for their rings, prove every claim before the load,
take a baseline, apply rising transaction rates until a stop rule fires, measure recovery, then
reconcile every submitted transaction against the finalized chain and the node's ready pool.
Results are in the job summary and the uploaded `flood-results` artifact.

## What lives where

Polkameter submits the prepared transactions, controls the rate, follows blocks, reconciles
every transaction, scrapes the nodes, observes the relay for parachain 1502 and judges block
production, the pool and PVF. Everything specific to People is in [`people-plugin/`](people-plugin):

- `preflight`, `recognize`, `prepare-claims`, `validate-prepared`: the setup and the ring-proof
  claims, with the v5 extension encoding and its layout check ([`proofs/`](proofs) makes the
  proofs);
- `check-state`: whether finalized claims left their allowance entry;
- `recycler-start`, `recycler-stop`, `recycler-checks`: the Recycler observer. It records ring
  backlog, maintenance calls and cleanup into the run, and judges them after the load.

The plugin builds against `polkameter-plugin-sdk` 0.4 from crates.io, and the workflow installs
the PolkaMeter 0.4.0 CLI release. Bump the SDK in `Cargo.toml` and `POLKAMETER_VERSION` in
`stress-flood.yml` together.

## Plans

| Plan | People × slots | Load | Recovery / baseline probes | People cores / collators |
| --- | --- | --- | --- | --- |
| `smoke` | 40 × 12 | 2, 4, 6 tx/s for 30 s each | 120 s / 3 | 1 / 1 |
| `capacity` | 250 × 20 | 12, 15, 18, 21 tx/s for 60 s each | 900 s / 5 | 3 / 5 |
| `default` | 750 × 20 | 6 tx/s, + 4 tx/s per step, ten 60 s steps | 900 s / 5 | 3 / 5 |

The topology is not in the plan. The workflow's `PLAN_NAME` case sets the People cores and
collators (the last column), and the bite and the start use the same layout. Each plan declares
the block interval it expects (6 s on 1 core, 2 s on 3 cores). The run measures the interval
before setup and stops if it differs by more than 25%, so a plan never runs on a topology it was
not written for. To try another combination, add a plan, a `case` arm in the workflow and a row
in the table above.

## Results and exit code

Smoke mode fails the job on any gap: a monitor problem or a required check without a result,
including the Recycler checks. Stress mode (capacity and default) is a measurement, not a gate:
the job fails only when the network, the setup or the tools fail, and failed health checks are
reported in the summary.

Each run directory holds `summary.md`/`summary.json` (verdicts and stop reason),
`transactions.jsonl` (one accounting status per submitted transaction), raw scrapes, blocks,
and the plugin's own series in `plugins/people/`. `polkameter report <run directory>`
regenerates the checks offline.

## Running it locally

Install the PolkaMeter CLI release and build the plugin here:

```sh
curl -fsSL https://raw.githubusercontent.com/agustinustheo/polkameter/v0.4.0/install.sh | sh -s -- 0.4.0
cargo build --release --locked --bin polkameter-people-plugin   # in stress/
polkameter plugin install target/release/polkameter-people-plugin
polkameter plugin credential previewnet-sudo POLKAMETER_SETUP_SURI
```

The plugin build needs a C compiler (`build-essential`, for `ring`); the engine needs `make` and
`jq`. The workflow installs them when they are missing.

Then start a previewnet fork with Zombienet (`ppn fork toml <bundle> <out>` in previewnet-engine
writes its config), register the `zombie.json` Zombienet writes, and run a plan:

```sh
polkameter plugin topology previewnet /path/to/zombie.json
POLKAMETER_SETUP_SURI=//Alice \
  polkameter run plans/people-smoke.polkameter.xml --output runs --fail-on error
```

`cargo test` here checks the claim encoding, people generation and proofs against
`people-plugin/tests/vectors/claim.json`, a frozen fixture written once by the TypeScript tool.
Nothing regenerates the fixture, and no TypeScript runs in CI.
