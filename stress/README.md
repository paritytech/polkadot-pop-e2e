# Stress flood

`.github/workflows/stress-flood.yml` floods People on a fresh fork of previewnet with
proof-authorized statement claims and measures where the chain degrades. It runs
[Polkameter](https://github.com/agustinustheo/polkameter) with its People plugin, driven by
an XML plan in [`plans/`](plans). It replaces the standalone Rust `stress` tool proposed in
#37; the load, recovery, loss and check semantics are the same code, migrated into Polkameter.

One run: recognize people with sudo, wait for their rings, prove every claim before the
load, take a baseline, apply rising transaction rates until a stop rule fires, measure
recovery, then reconcile every submitted transaction against the finalized chain and the
node's ready pool. Results are in the job summary and the uploaded `flood-results` artifact.

## Plans

| Plan | People × slots | Load | Recovery / baseline probes | People cores / collators |
| --- | --- | --- | --- | --- |
| `smoke` | 40 × 12 | 2, 4, 6 tx/s for 30 s each | 120 s / 3 | 1 / 1 |
| `capacity` | 250 × 20 | 12, 15, 18, 21 tx/s for 60 s each | 900 s / 5 | 3 / 5 |
| `default` | 750 × 20 | 6 tx/s, + 4 tx/s per step, ten 60 s steps | 900 s / 5 | 3 / 5 |

Each plan declares the block interval it expects (6 s on 1 core, 2 s on 3 cores). The run
measures the interval before setup and stops if it differs by more than 25%, so a plan
always runs on the topology it was written for. The workflow derives that topology from the
plan; to try another combination, add a plan and a row in the workflow's topology table.

## Results and exit code

Smoke mode fails the job on any gap: a monitor problem or a required check without a result.
Stress mode (capacity and default) is a measurement, not a gate: the job fails only when the
network, the setup or the tool fails, and failed health checks are reported in the summary.

Each run directory holds `summary.md`/`summary.json` (verdicts and stop reason),
`transactions.jsonl` (one accounting status per submitted transaction), raw scrapes,
blocks and OpenMetrics. `polkameter report <run directory>` regenerates the checks offline.

## Running it locally

From a Polkameter checkout, with a Zombienet config of a previewnet fork
(`ppn fork toml <bundle> <out>` in previewnet-engine):

```sh
pnpm install && pnpm build
cargo build --release -p polkameter -p polkameter-scenarios
scripts/local-people-run.sh /path/to/fork.toml /path/to/polkadot-pop-e2e/stress/plans/people-smoke.polkameter.xml
```

## Updating Polkameter

`POLKAMETER_REF` in the workflow pins the Polkameter commit that is built. Bump it to a
newer commit on Polkameter's `main` to pick up changes.
