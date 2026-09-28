# Stress tests in Rust

The Rust port of `packages/stress-tests`, built the way `../STRESS-RUST.md` proposes. One
scenario so far: the statement-store claim flood. The files a run writes are the TS tool's, so
TS `recheck` reads a Rust run and `stress check` reads a TS run.

## Build

```sh
cargo build --release      # about 1 min clean; the binary is target/release/stress
```

## Run

Needs a local previewnet fork from `previewnet-engine` (People on 3 cores:
`make start FORK=1 FRESH_BITE=1 CORES="people=3" COLLATORS="people=5"`).

| Variable | Default | What |
| --- | --- | --- |
| `ZOMBIE_JSON` | `$PPN_DIR/data-fork/zombie.json`, else `data/` | The network's nodes, for the scraper |
| `PEOPLE_WS` | `ws://127.0.0.1:10010` | The People collator we submit to |
| `RELAY_WS` | `ws://127.0.0.1:10000` | The relay node the relay recorder follows |
| `PEOPLE_PID` | the process on `PEOPLE_WS`'s port | The People node the process sampler reads |
| `SUDO_URI` | `//Alice` | The sudo account of the fork |

```sh
# A short run that must pass: any monitor problem or a check without a result fails it.
./target/release/stress stmt-flood --mode smoke \
  --members 40 --slots 12 --start 2 --step 2 --interval 30 --steps 3 --recovery 120 --probes 3

# The stress run: 750 people x 20 slots, from 6 tx/s up by 4 per step, 10 steps of 60 s.
./target/release/stress stmt-flood

# run.om and the checks again, from a run's files (a TS run too).
./target/release/stress check results/<run>
```

A run writes `results/<scenario>-<unix seconds>/`: the raw files (`scrapes.jsonl`,
`blocks.jsonl`, `load.jsonl`, `chain.jsonl`, `node.jsonl`, `steps.jsonl`), `run.om`,
`summary.json` and `summary.md`.

## Check

`./ci.sh` runs clippy with warnings denied, the tests, and the guard that no crate turns
`ark-vrf/parallel` back on. `cargo run --release -p stress-checks --example compare_ts_run --
../packages/stress-tests/results` compares the checks and `summary.md` with the TS tool's on
its saved runs.

## Layout

Eight crates under `crates/`: `files` (the on-disk contract), `chain`, `proofs`, `monitors`,
`load`, `checks`, `scenarios`, `cli`. `STRESS-RUST.md` explains each one and the core types.
One change to its diagram: `monitors` uses `chain` too, for the relay and Recycler recorders.

Adding a scenario is a module in `crates/scenarios/src/` and three lines in
`crates/cli/src/main.rs`; `scenarios/src/coin` and `renewal` are stubs that show the shape.

## Status against STRESS-RUST.md's migration steps

1. This workspace, with `ci.sh` for the CI job: done.
2. Relay recorder, Recycler recorder, process sampler: written and lint-clean; the smoke run
   next to TS `recheck` is still open, because the fork restored on 2026-09-28 does not
   author People blocks (its collators' keys are not the authorities in the snapshot).
3. All 15 checks and the whole `summary.md`: done; identical to TS on the saved runs made
   with the current TS checks (`compare_ts_run`).
4. A full stress run next to the TS one on the same fork: not run yet.
5. The `stress-flood.yml` step: outside `stress/`, not done.
6. Coin flood, unload burst, renewal hour: stubs only.

Two examples help when a fork misbehaves: `stress-chain --example para_state -- <relay ws> 1502`
(the relay's head and pending upgrades for People) and `--example authorities -- <people ws>`
(who may author now).
