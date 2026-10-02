# Coinage lifecycle pilots

The campaign workflow runs one disposable PreviewNet network at a time:

1. Split and claim at 100, 1,000 and 10,000; default pool.
2. Recycling at 100, 1,000 and 10,000; default pool.
3. For each failed 10k baseline: 8k + 2k paced with defaults, then 10k with an enlarged pool.
4. Split and claim at 20k, 40k, 100k with enlarged pools.
5. Recycling at 20k, 40k, 100k with enlarged pools.

Every case starts with a one-actor smoke on a separate instance. Failure does
not skip the next independent case. Cancellation stops the campaign. A setup
failure is recorded separately and must be repaired before claiming that load ran.
The reusable workflow takes scenario, actors, mode and pool inputs; it is not
an independent concurrent dispatcher.

Enlarged pools allow 11k, 22k, 44k and 110k entries respectively, with a
262,144 KiB byte budget on both People collators. These are experimental settings.
Default-pool cases remove both overrides. Signed calls are prebuilt; there are
no transaction retries. Launch targets are 1 s through 20k, 5 s at 40k and 10 s
at 100k. Receipt/readiness deadlines are 10 minutes per wave through 10k and
30 minutes above 10k. Record the actual send window: missing it is a generator
limit, not a chain-capacity result.

In the paced case, finish and audit the first 8,000 payments (both split and
claim) before the remaining 2,000. Recycling also waits for first-group ring
readiness. A failed gate leaves the second group unsubmitted.

| Pilot | Work | Design |
| ----- | ---- | ------ |
| Split and claim | N two-output splits, audit barrier, then N recipient claims | [Payment pilot](https://github.com/paritytech/technical-design/blob/indiv-non-fn-testing/designs/individuality/non-fun-tests/test-design/scenarios/payment-burst.md#next-pilot-split-and-claim) |
| Recycling | N coin loads into one denomination collection, then observe real ring builds | [Recycling pilot](https://github.com/paritytech/technical-design/blob/indiv-non-fn-testing/designs/individuality/non-fun-tests/test-design/scenarios/synchronised-recycling.md#next-pilot-coin-loads-into-one-recycler-collection) |

Both reuse the PreviewNet engine, two People collators, receipt audit and bounded
submitter from the claim workflow. Root-seeded coins bypass issuance and wrapped
asset holds. Explicit fixture backing is checked before and after, but this is
not an issuance or offboarding test. Every measured call uses a real coin
signature. The one-actor smoke confirms the runtime accepts the fixed plan;
the pilot does not assume a universally exposed maximum-age metadata constant.

The split barrier waits for all split receipts and states before signing claims.
Completion time includes that barrier and claim signing. Per-wave finality
starts at each call's submission and ends after its finalized receipt lookup.
Neither timing simulates chat or a production wallet planner.

Recycling ends at chain ring readiness, not a wallet's privacy delay or a
successful unload. Every fixture coin is declared due at release by a test-owned
scheduling override. Readiness is observed from finalized state at five-second
polls; unobserved members remain unresolved. Root existence and inclusion count
must cover the member's position. The evidence records when it was observed.

## Evidence

Download the `coinage-<scenario>-<count>-<mode>-<pool>-results-*` artifact.
The final `-pilot-*` artifact also includes recovery observations.
Check `<scenario>-pilot-summary.json`, then repeat the saved-evidence checks:

```sh
python3 ci/previewnet/verify-lifecycle-artifact.py /path/to/artifact --scenario split --expected 100
python3 ci/previewnet/verify-lifecycle-artifact.py /path/to/artifact --scenario recycle --expected 100
```

Each command also requires the separate one-actor smoke evidence. It verifies
raw receipts using the existing verifier, then the scenario's event fields,
coin state, backing and (for recycling) saved ring-inclusion evidence. Receipt
reads use both local People nodes; these files are RPC evidence, not independent
cryptographic proofs. A missing overall summary cannot pass on smoke alone.

Signed calls, fixture public addresses, per-wave summaries, state, raw blocks,
watch transitions, readiness evidence, process samples and errors are retained
for 30 days. Secret keys and chain databases are not uploaded. Results upload
before recovery; continued finality and both collator authors are checked after.
If a runner disappears, its local-only samples may still be unavailable.

No live result is claimed until the workflow and artifact checks have completed.

## Interpreting duration and resources

Fixture creation, initial state checks and pre-signing are outside the measured
load. Per-call finality is client submission to receipt lookup after finalization.
Split-and-claim completion includes its split audit and claim signing barrier;
it ends at the last settled claim watch. Stage elapsed time additionally includes
state audits, ring observation and observer shutdown. Readiness is per member
from its own submission to the first finalized poll proving root coverage, so
paced-group waiting is not counted as that member's readiness latency.

Preserve signed bytes, raw blocks, decoded indexed events, two-node finality
views, fixture/state snapshots, watch outcomes and readiness polls. Pool and
process samples help diagnose bottlenecks, but do not prove weight accuracy
or PVF deadline compliance. Do not describe a runner loss as OOM without evidence.

## Resume after a setup or runner failure

The campaign accepts a JSON list of case IDs. Keep ["all"] for a full run.
Use an explicit list such as ["a1000"] to repeat a case that never reached its
workload. This does not rerun successful cases or infer success from a setup
attempt. All invocations share one concurrency group, so recovery runs queue
behind an active campaign. Dispatch recovery only after reviewing missing cases;
GitHub retains only one pending run per concurrency group.

Case IDs are a100, a1000, a10000, b100, b1000, b10000,
a_paced, a_pool, b_paced, b_pool, a20000, a40000,
a100000, b20000, b40000, b100000. Explicit selection also permits
a required fallback after its failed baseline was recorded in an earlier run.
Retain both run URLs and classify the original failure separately.

Recovery runs preserve a small runner-preflight artifact before network setup.
It records CPU affinity, cgroup limits and initial memory/OOM counters. If a
runner disappears later, this establishes its initial environment, but does not
prove the cause of failure. Workload artifacts and final counters may still be
missing. Do not count such a job as a submitted workload.
