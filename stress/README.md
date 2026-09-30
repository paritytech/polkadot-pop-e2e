# People stress tests

`stress` is the Rust load generator and evaluator for People. A run provisions test
identities, prepares proof-bearing transactions, records the relay and People nodes, ramps
load until a failure rule is reached, measures recovery and loss, and writes a Markdown
report.

> [!WARNING]
> Run this only against a disposable local fork. The tool uses sudo to change chain state and
> deliberately drives the network beyond its capacity.

## Scenario support

| Command | Status | Load |
| --- | --- | --- |
| `stmt-flood` | Ready | `Resources.set_statement_store_account` claims with ring-VRF proofs |

Use `stress --help` or `stress <command> --help` for the complete CLI reference.

## Quick start

### 1. Start a previewnet fork

The statement flood needs live previewnet state, working People block production, built
rings, and a sudo account. The tested topology gives People three cores and five collators:

```sh
make -C "$HOME/projects/previewnet-engine" start \
  FORK=1 FRESH_BITE=1 CORES="people=3" COLLATORS="people=5"
```

If the engine is elsewhere, set `PPN_DIR` before running the stress tool.

### 2. Build the tool

From this directory (`stress/`):

```sh
cargo build --release --locked
```

### 3. Run a smoke test

```sh
./target/release/stress stmt-flood --mode smoke \
  --members 40 --slots 12 \
  --start 2 --step 2 --interval 30 --steps 3 \
  --recovery 120 --probes 3
```

Smoke mode is intended to validate the setup and observability. It exits non-zero for a
monitor problem or when a required outcome check has no result.

### 4. Run the full stress measurement

```sh
./target/release/stress stmt-flood
```

!TODO: we want to porbably just point to the defaults inside the `some-path:XYZ` file
The defaults prepare 750 people × 20 slots (15,000 claims), then run ten 60-second steps
from 6 tx/s to 42 tx/s in increments of 4 tx/s. Recovery is observed for up to 900 seconds.
Proof generation and waiting for rings happen before the ramp and can take several minutes.

## What a run does

```text
preflight → scenario setup → baseline probes → stepped load
          → recovery probes → loss check → outcome checks → report
```

- **Preflight** verifies node access, metric types, runtime transaction extensions, and the
  initial block interval.
- **Setup** recognizes people, waits for their rings, and generates all ring proofs before
  load starts.
- **Baseline** requires healthy probe transactions before collecting a measurement.
- **Load** increases the target rate and stops at the first configured failure rule.
- **Recovery** stops ordinary load, sends one probe per block, and waits for both service
  recovery and backlog drain.
- **Loss check** reconciles submitted transactions with blocks, the node pool, and chain
  state.
- **Outcome checks** evaluate block production, PVF behavior, the transaction pool,
  Recycler behavior, and recorder completeness.

### Run modes

| Mode | Purpose | Exit behavior |
| --- | --- | --- |
| `stress` (default) | Measure where and how the network fails | Chain degradation is reported as the result; setup and tool errors still fail the process |
| `smoke` | Verify that a short run produces complete data | Also fails for monitor problems and required checks with no result |

A `fail` verdict in the report describes the system under test; it does not by itself make a
stress-mode process fail.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PPN_DIR` | `$HOME/projects/previewnet-engine` | Previewnet-engine directory used to find `zombie.json` |
| `ZOMBIE_JSON` | First existing file under `$PPN_DIR/data-fork/` or `$PPN_DIR/data/` | Explicit topology and metrics endpoints |
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
| `blocks.jsonl` | Blocks observed by the load tracker |
| `node.jsonl` | People process CPU and memory samples |
| `steps.jsonl` | Final measurements for each load step |

Rebuild `run.om` and rerun all checks without a network:

```sh
./target/release/stress check results/<run-directory>
```

The file schema is compatible with `packages/stress-tests`: the Rust evaluator can recheck a
TypeScript run, and the TypeScript `recheck` command can evaluate a Rust run.

## Development

Run the same checks as CI:

```sh
./ci.sh
```

This runs Clippy with warnings denied, the release-mode test suite, and a feature guard that
prevents `ark-vrf/parallel` from being enabled. The guard matters because nested Rayon pools
can exhaust threads during long proof-generation runs.

To compare the Rust evaluator with saved TypeScript results:

```sh
cargo run --release -p stress-checks --example compare_ts_run -- \
  ../packages/stress-tests/results
```

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
records, while `checks` reads only the finished run. For the original design rationale and
migration history, see [`../STRESS-RUST.md`](../STRESS-RUST.md).
