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

- Top-up: one real unpaid load per actor, successful finality, zero remaining actor asset balance, matching Coinage.Wrapped held backing (separate from the pallet’s minimum free balance), and voucher membership in a built root. Ring readiness is separate from transaction finality and does not include a mobile wallet's privacy delay.
- Claim: one real signed transfer per seeded source coin. Every source disappears, each recipient gets the expected coin at age + 1, and backing stays unchanged. Root seeding bypasses issuance and does not prove the full wallet flow.
- “Users” is the driver input name. It means distinct actor keys with one operation each; it does not measure real users or an app population model.
- Driver launch time is not RPC acceptance or network arrival time. The top-up driver records legacy RPC `ready` notifications as client-observed pool readiness; older artifacts record PAPI broadcast signals, which are not node acknowledgements. A 1,000-operation run is not evidence of 1,000 accepted transactions per second.
- Event dispatch weights are declared/accounted weights, not measured execution time. Prometheus coverage depends on the binary; missing PVF, pool or authoring metrics remain gaps. Passing does not prove correct weights or production capacity.

## Moving to 10,000 top-ups

Validate both scenarios at 1,000 first. Then run only the top-up workflow with `users=10000`, using the same smoke gate, audit and ten-minute post-release observation deadline. Fixture creation is outside that deadline and can take about an hour because funding batches finalize sequentially. Preserve failed runs, including generator-limited results; do not weaken pass criteria to obtain a green job.

The top-up driver uses one `author_submitAndWatchExtrinsic` connection and reads each finalized block once for its transaction outcomes. It does not retry failed watches. People nodes retain state in archive mode so the receipt audit and collator check can read earlier blocks after a long fixture setup. Record this configuration when comparing runs.

The first audited 10,000 attempt ([run 36517423226](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36517423226)) failed in the generator: 7,500 submitted over 263 seconds, 7,494 verified finalized receipts, and 2,500 not submitted after an observer timeout. State showed 7,500 debits and ready vouchers. Its 667 full clients reached about 4.7 GiB RSS. This is a failed generator result, not a measured chain capacity limit. Keep that artifact separate from reruns using the shared connection.
