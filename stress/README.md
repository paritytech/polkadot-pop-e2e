# Individuality Community stress tests

`stress` is a Rust-based non-functional testing kit for the systems and chains within
[Individuality Community](https://github.com/paritytech/individuality-community). It combines
scenario setup, transaction preparation, load generation, monitoring, evaluation, and reporting.

A run verifies baseline health, applies increasing load while recording the network, measures
recovery and transaction loss, and writes a Markdown report.

> [!WARNING]
> Run this only against a disposable local fork. The tool uses the chain's sudo origin to change
> state and deliberately drives the network beyond its capacity.

See [scenario coverage](./docs/coverage.md) for available tests.

## Prerequisites

- A stable Rust toolchain.
- A local checkout of [previewnet-engine](https://github.com/paritytech/previewnet-engine).
- A disposable previewnet fork with live state, working People block production, and built rings.
- Ports `10000` (relay) and `10010` (People) available, unless `RELAY_WS` and `PEOPLE_WS`
  point to different endpoints.

## Quick start

> [!NOTE]
> Use `stress --help` or `stress <command> --help` for the complete CLI reference.

### 1. Start a previewnet fork

Set `PPN_DIR` to your local previewnet-engine checkout, then start the tested topology:

```sh
export PPN_DIR="/absolute/path/to/previewnet-engine"

make -C "$PPN_DIR" start \
  FORK=1 FRESH_BITE=1 \
  CORES="people=3" \
  COLLATORS="people=5"
```

Keep `PPN_DIR` exported when running `stress`; it is used to locate `zombie.json`.

### 2. Build the tool

From this directory (`stress/`):

```sh
cargo build --release --locked
```

### 3. Run a smoke test

```sh
./target/release/stress stmt-flood --mode smoke \
  --start 2 --step 2 --interval 30 --steps 3 \
  --recovery 120 --probes 3
```

Smoke mode is intended to validate the setup and observability. It exits non-zero for a
monitor problem or when a required outcome check has no result.

### 4. Run the full stress measurement

```sh
./target/release/stress stmt-flood
```

The authoritative defaults are `Options` and `StmtFlood::RAMP` in
[`crates/scenarios/src/stmt/flood.rs`](./crates/scenarios/src/stmt/flood.rs). The current defaults
run ten 60-second steps from 6 tx/s to 42 tx/s in increments of 4 tx/s, and prepare as many
people as that ramp and the probes need (about 740 people × 20 slots). Recovery is observed for
up to 900 seconds. Proof generation and waiting for rings happen before the ramp and can take
several minutes.

`--growth <factor>` multiplies the rate every step instead of adding `--step`, e.g.
`--start 10 --growth 2 --steps 5` runs 10, 20, 40, 80 and 160 tx/s. It reaches failure in fewer
steps, but the breaking point lies anywhere between the last two rates. `--members` is derived
from the ramp and the probe reserve when left out, so the claims cannot run out; give it only to
test a bigger ring (a value too small for the ramp fails at setup).
!TODO: maybe we want to provide the option of not providing `--steps`, which runs until the first failure happens (like tx pool limit)

### 5. Stop the previewnet fork

After the run, stop the network:

```sh
make -C "$PPN_DIR" kill
```

## What a run does

```text
preflight → scenario setup → baseline probes → stepped load
          → recovery probes → loss check → outcome checks → report
```

- **Preflight** verifies connectivity, observability, runtime compatibility, and the initial
  conditions required by the scenario.
- **Setup** performs scenario-specific preparation, such as creating accounts, changing chain
  state, generating workload data, or preparing proofs.
- **Baseline** confirms that representative operations succeed under minimal load and records
  reference measurements.
- **Load** executes the scenario's load plan until it completes or reaches a configured stopping
  condition.
- **Recovery** stops the generated load and observes whether service returns to its baseline
  behavior and any accumulated backlog drains.
- **Loss check** reconciles submitted operations with observed responses, blocks, queues, and
  final state to identify pending or lost work.
- **Outcome checks** evaluate shared network-health signals and scenario-specific expectations
  using the collected data.

### Run modes

| Mode | Purpose | Exit behavior |
| --- | --- | --- |
| `stress` (default) | Measure where and how the network fails | Chain degradation is reported as the result; setup and tool errors still fail the process |
| `smoke` | Verify that a short run produces complete data | Also fails for monitor problems and required checks with no result |

A `fail` verdict in the report describes the system under test; it does not by itself make a stress-mode process fail.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PPN_DIR` | None | Previewnet-engine directory used to find `zombie.json`; required unless `ZOMBIE_JSON` is set |
| `ZOMBIE_JSON` | Auto-detected under `PPN_DIR` | Explicit path to the topology and metrics endpoints |
| `PEOPLE_WS` | `ws://127.0.0.1:10010` | People node used for reads and submissions |
| `RELAY_WS` | `ws://127.0.0.1:10000` | Relay node followed by the relay recorder |
| `PEOPLE_PID` | Process listening on the `PEOPLE_WS` port | Process sampled for CPU and memory |
| `SUDO_URI` | `//Alice` | Sudo signer used during scenario setup |

## Results and rechecking

Each run creates `results/<scenario>-<unix-seconds>/` (override the root with `--out`):

| File | Contents |
| --- | --- |
| `summary.md` | Human-readable result and outcome checks |
| `summary.json` | Structured run parameters, measurements, and check verdicts |
| `run.om` | Merged OpenMetrics data consumed by the evaluator |
| `scrapes.jsonl` | Raw node metric scrapes |
| `chain.jsonl` | Relay and Recycler recorder series |
| `load.jsonl` | Sender and transaction tracker series |
| `blocks.jsonl` | Blocks read by the load tracker: every best block, and the ones filled in below one after a reorg (`filledIn`) |
| `node.jsonl` | People process CPU and memory samples |
| `steps.jsonl` | Final measurements for each load step |
| `lost.jsonl` | Each lost flood tx: step, scenario details, its state on the finalized chain, and a fresh validation |

Rebuild `run.om` and rerun all checks without a network:

```sh
./target/release/stress check results/<run-directory>
```

## Development

Run the same checks as CI:

```sh
./ci.sh
```

This runs Clippy with warnings denied, the release-mode test suite, and a feature guard that
prevents `ark-vrf/parallel` from being enabled. The guard matters because nested Rayon pools
can exhaust threads during long proof-generation runs.

The GitHub Actions entry point for an end-to-end run is
[`.github/workflows/stress-flood.yml`](../.github/workflows/stress-flood.yml).

## Workspace layout

| Crate | Responsibility |
| --- | --- |
| `files` | Run directory schema, metric registry, OpenMetrics conversion, summary types |
| `chain` | People RPC reads, transaction construction, and sudo setup |
| `proofs` | Parallel ring-VRF proof generation |
| `monitors` | Metrics scraper, relay/Recycler recorders, and process sampler |
| `load` | Plans, sender, block follower, tracker, stop rules, recovery, and loss checks |
| `checks` | Offline evaluator and Markdown/JSON report generation |
| `scenarios` | Scenario-specific setup and transaction sources |
| `cli` | The `stress` binary and component wiring |

The file formats are the boundary between components: monitors and the load runner write raw
records, while `checks` reads only the finished run.
