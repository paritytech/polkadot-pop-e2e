# How to check a Coinage burst result

A green job is not the result by itself. Download the `coinage-burst-results-<run>-<attempt>` or `coinage-claim-results-<run>-<attempt>` artifact from the run's Summary page. These are uploaded before recovery checks. Full artifacts also include node logs and network configuration. Retention is 30 days; download results you need to keep longer.

Start with `burst-report.md` or `claim-burst-report.md`. The corresponding audit must show the requested count of unique verified receipts and no errors. The summary must pass the finality, state and launch-window checks. The smoke stage is separate and does not count toward the requested burst.

| File | Evidence |
| ---- | -------- |
| `*-transactions.csv` | Actor, transaction hash, finalized block, extrinsic index and latency. |
| `*-receipts.json` | Successful dispatch and the expected Coinage event for each transaction. |
| `evidence/<stage>/block-*.json` | Raw block bodies, fresh reads of System.Events, and canonical/finalized observations from both People nodes. Hashing the recorded extrinsic must reproduce its transaction hash. |
| `*-state.json` | Finalized balances and ring state for top-ups, or source/recipient coin state for claims. |
| `*-fixture.json`, `*-runtime.json`, `provenance.json`, `snapshot.json` | Inputs, setup method, runtime/node versions, snapshot and execution parameters. Private keys are excluded. |
| `node-metrics.jsonl`, `metrics-endpoints.json` | Sampled Prometheus data from discovered nodes, including missing-endpoint and fetch errors. Metric names and HELP text describe what the binary exposes. |
| `process-samples.txt`, `*-samples.jsonl` | Process CPU/RSS, driver resources, finality progression and scenario-specific backlog observations. |

Recheck saved transaction receipts locally, without a node or Node.js dependencies:

```sh
python3 ci/previewnet/verify-burst-artifact.py /path/to/extracted/artifact
```

This independently re-reads the saved block bodies instead of trusting the transaction watcher's success flag. It checks unique actors/hashes, block indexes, matching Blake2b-256 hashes, dispatch success and Coinage events. The online audit additionally reads both local nodes. These are trusted local RPC observations, not cryptographic storage or consensus proofs; a fabricated artifact cannot be ruled out by hashing its own contents alone.

## What the runs establish

- Top-up: one real unpaid load per actor, successful finality, zero remaining actor asset balance, matching pallet backing, and voucher membership in a built root. Ring readiness is separate from transaction finality and does not include a mobile wallet's privacy delay.
- Claim: one real signed transfer per seeded source coin. Every source disappears, each recipient gets the expected coin at age + 1, and backing stays unchanged. Root seeding bypasses issuance and does not prove the full wallet flow.
- “Users” is the driver input name. It means distinct actor keys with one operation each; it does not measure real users or an app population model.
- Driver launch time and PAPI's broadcast signal are not RPC acceptance or network arrival times. A 1,000-operation run is not evidence of 1,000 accepted transactions per second.
- Event dispatch weights are declared/accounted weights, not measured execution time. Prometheus coverage depends on the binary; missing PVF, pool or authoring metrics remain gaps. Passing does not prove correct weights or production capacity.

## Moving to 10,000 top-ups

Validate both scenarios at 1,000 first. Then run only the top-up workflow with `users=10000`, using the same smoke gate, audit and ten-minute post-release observation deadline. Fixture creation is outside that deadline and can take about an hour because funding batches finalize sequentially. Preserve failed runs, including generator-limited results; do not weaken pass criteria to obtain a green job.

## 10,000 simultaneous claims

For the 10,000-claim comparison, the workflow uses the same single-connection `author_submitAndWatchExtrinsic` transport as the top-up experiment, with no automatic retries and default pool limits unless explicitly changed. The one-second launch target and ten-minute observation deadline apply to each wave. Fixture setup is outside that window; the job allows 120 minutes and the driver 90 minutes for preparation plus measurement. Snapshot pruning stays at 256 blocks; recovery checks up to 64 recent finalized blocks.

Each actor has one root-seeded source coin and submits one real signed `transfer`. Every successful run must have all requested successful finalized receipts, no source coins remaining, correct recipient coins and unchanged fixture asset balance. Root seeding bypasses issuance and normal held-backing setup; this does not test the full payment lifecycle. Client-observed pool-ready timestamps are distinct from successful finality. A dropped watch still fails the receipt requirement unless separately reconciled; balances alone are not receipts.

## Paced claims and larger-pool comparison

First dispatch `users=10000`, `mode=paced`, `first_wave=8000`, `pool=default`. All coins are seeded and all claims signed before measurement. Wave two submits the remaining 2,000 only after wave one's successful finalized receipts are verified against both People nodes. A failed receipt gate stops the next wave; there are no retries. Final state checks still cover all 10,000 requested actors.

`claim-burst-waves.json` records each wave's start, launch window and settlement time. The wave audit files check cumulative receipts (8,000, then 10,000). `sendWindowMs` is the largest individual launch window. `settledAtMs` runs from the first wave's start to the last watch result, including the first receipt gate. `elapsedMs` also includes the last wave audit, observer shutdown and final state queries; it excludes fixture preparation, the final aggregate receipt audit and recovery. Finality percentiles measure each successful claim from its own submission through finalized notification and receipt lookup, not from the first wave's start.

Then dispatch `users=10000`, `mode=burst`, `pool=enlarged`. Both People collators receive `--pool-limit=11000 --pool-kbytes=40960` (40 MiB of transaction bytes). Check the effective limits in the saved startup logs. This separate experiment changes buffering, not block execution capacity. Push-triggered checks remain 1,000 claims in one burst with the default pool.

### Claim capacity exploration

The claim workflow accepts up to 100,000 actors. This is a safety ceiling for the
experiment, not a measured capacity. Start at 20,000 with `pool=enlarged` and
`pool_transactions=22000`; increase only after inspecting receipts, state,
recovery and resource samples. The enlarged pool keeps its 40 MiB byte budget.
Each run still launches one signed transfer per source coin, with no retries.
The launch target defaults to one second. Larger experiments can request up to
ten seconds with `launch_target_ms`; record both the target and measured window.
A missed target is a generator limit, not proof that the chain cannot execute
that many claims. Never label a multi-second burst as a one-second result.

`fixture_batch` defaults to 1,000 root-seeded coins per setup transaction (formerly
100), with an explicit option up to 5,000 for larger experiments. Setup is excluded from burst timing and every seeded source coin is checked
before signing. This improves preparation time without changing the claim calls.
Setup and post-burst state reads use groups of 64 (formerly 16); every actor
is still checked. Finish all fixture snapshot reads before signing, so large
loads cannot age that snapshot out while later actors still need to read it.
This concurrency is recorded in the fixture artifact.
RPC subscription capacity scales with the requested actor count and is recorded
in the fixture artifact. Compare actual pool startup arguments and hardware
between runs; the runner label alone does not identify the machine's capacity.

`runner-hardware.json` records CPU details, affinity, memory and cgroup limits,
and disk capacity. `node-metrics.jsonl` also records host CPU, memory pressure,
I/O and cgroup counters every five seconds. Missing counters remain explicit.
Report burst admission, successful finalized receipts, finality latency and
recovery separately. All local network processes share this runner, so the result
is a limit of this test deployment, not a production-wide Coinage capacity claim.

The capacity series pins the September 29 snapshot artifact and its SHA-256 in
the workflow, matching the successful September 30 claim experiments. The
`bites` release replaces its bundle nightly. An expired or changed pinned
artifact must fail setup, rather than silently change the experiment. Keep a
local copy of the bundle before its artifact retention expires. Runtime block
limits and signed claim bytes are saved alongside subsequent capacity results.

### Verified claim capacity results — 1 October 2026

All three runs below have the requested number of unique successful finalized
receipts, correct source/recipient coin states, unchanged fixture backing, and
passing recovery checks. Saved raw blocks and indexed events were checked again
locally. There were no retries, failed dispatch receipts, or unresolved receipts.

| Claims / run | Pool entries | Actual client launch | Last watch receipt from burst start | Per-claim finality p50 / p95 / max |
| --- | ---: | ---: | ---: | ---: |
| [20,000](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36832069153) | 22,000 | 0.802 s | 94.263 s | 65.711 / 93.806 / 93.914 s |
| [40,000](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36836204912) | 44,000 | 1.582 s | 140.925 s | 92.300 / 139.394 / 139.566 s |
| [100,000](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36840043405) | 110,000 | 3.930 s | 312.867 s | 178.521 / 297.346 / 310.339 s |

Each percentile uses all successful claims in that row. The launch targets were
one, five and ten seconds respectively; the larger runs are not one-second
bursts. Every pool retained the same 40 MiB byte budget. Runtime, binaries and
snapshot bytes were pinned, with zero added network delay. Preparation batches
and query concurrency changed as described above and are recorded in each fixture.

The 100,000-claim run used commit `b7451cd`, prepared its fixtures and signatures
in 2,440.797 seconds, and took 410.385 seconds for the measured stage including
final state reads. That stage excludes preparation, the final receipt audit and
recovery. Its receipts fill 43 blocks: 42 with 2,363 claims and one with 754.

That runner reported AMD EPYC 7B13, 16 cores / 32 logical CPUs and about 62.8 GiB
RAM. Samples taken every five seconds around the burst reached 21.3% host-wide
CPU busy and a minimum of 43.0 GiB available RAM, with no service-cgroup OOM
events. One logical CPU reached 98%; the host average does not rule out serial
execution limits. The submission node's sampled ready queue peaked at 88,185,
while watched transactions peaked at 100,000. Those are distinct measurements.
All 100,000 client-observed ready notifications arrived within 20.371 seconds.

Canonical authoring logs show `HitBlockWeightLimit` for all 42 full blocks and
`NoMoreTransactions` for the last. Maximum canonical proposal time was 2,970 ms;
this includes authoring work and is not a PVF execution-time measurement.
Increasing the pool let more claims wait without increasing claims per full block.

These are verified burst sizes, not a measured physical maximum or sustained TPS.
Use the full `coinage-claim-burst-<run>-1` artifacts for hardware records, node
logs, resource samples and raw receipts. The shared runner hosts the driver and
the entire local network; these results do not establish production capacity or
PVF deadline compliance.

The earlier [20,000 attempt](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36830248627)
never reached the claim driver: a changed nightly snapshot failed startup with
an Asset Hub HRMP-head mismatch. It is a setup failure, not a failed capacity step.

### Million-claim boundary experiment

Start at 1,000,000 claims. If this fails after valid preparation, test 500,000
and then bisect the passing/failing interval. Keep the same snapshot, binaries,
runner class, two People collators, zero added delay, 1,100,000 ready-pool entries,
262,144 KiB transaction-byte budget, 60-second client launch target and
3,600,000 ms watch deadline for the series. Report actual hardware for each run.
The subscription allowance remains `max(20050, 2 * actors + 50)` and is recorded.

This finds a repeatable burst boundary under these conditions, not a physical
maximum or sustainable TPS. A setup/signing/audit failure is not evidence of a
chain capacity failure. If a watch is dropped, reconcile it before calling that
claim unsuccessful. Repeat observations near the boundary before reporting it.
If one million passes, it establishes a lower bound; it does not locate a ceiling.

At this scale, both People nodes retain the latest 10,000 states for later receipt and state
queries. The driver has a 24 GiB V8 heap budget and an eleven-hour outer timeout;
the job reserves twelve hours for preparation, evidence and recovery. Preparation
still seeds batches of at most 5,000 coins, outside burst timing. Cached runtime
metadata avoids repeated decoding during signing; stock-signer equivalence is
checked in tests. Every claim still has its own source signature, PAPI-generated
call and extensions. Secret keys are released after signing. JSON evidence is
written in chunks and receipt events are indexed per block before verification.
These generator and retention changes must be noted when comparing with the
previous 100,000-claim run. No million-claim result has been established yet.

The [first million-claim attempt](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36856669186)
failed before submitting claims. The People node refused to change the snapshot
from constrained pruning (256 states) to archive mode. Increasing constrained
retention to 10,000 is supported; it retains new test history without pretending
to restore already-pruned snapshot history. This is a setup correction, not a
failed capacity point. Node logs were preserved locally with SHA-256 checksums.
