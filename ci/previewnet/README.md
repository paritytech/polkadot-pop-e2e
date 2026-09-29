# Previewnet with synthetic network delay

This readiness check runs the PreviewNet engine on one `parity-large` runner:
six relay validators and five parachain collators (two for People). It prepares for Coinage load
tests; it does not submit top-ups yet.

Use **Previewnet readiness with network delay**. `delay_ms` sets the extra delay
per direction on IPv4 loopback TCP P2P traffic. RPC is excluded. The default is
**1,000 ms (one second)** per direction, or roughly two seconds of added round-trip time.

1. Start the engine's snapshot topology with a second People collator. Wait for all
   chains to finalise, then enable both People authoring keys in the local fork.
2. Observe at least 60 seconds without synthetic delay. Every node must advance finality.
3. Apply Linux `tc/netem` and observe for 120 seconds. Record finality and best blocks,
   peer counts, and queue counters. Stalled finality is an observation, not a failed test.
4. Verify that packets entered the delay queue. Remove the qdisc and check that every
   node advances finality again within five minutes, over at least 60 seconds.
5. Verify from finalised block headers and parent-state Aura authorities that both
   People collators authored blocks.

The delayed window is 120 seconds. If configured above that (for example the previous
1,000-second disruption test), it tests interruption and recovery rather than waiting
for delayed delivery. Removing netem discards queued packets;
TCP and peers must recover. The queue holds up to 100,000 packets; inspect drop counters
before attributing an effect solely to delay. A shared host does not emulate separate
machines' CPU, disk or bandwidth limits.

The engine is pinned to `7907a3bfa7b2e47535a74b7920086a05ca94773a`. Node binaries
follow `environments/networks/previewnet.json`. Each run records snapshot asset IDs
and SHA-256 hashes. Its generated node configuration is retained; product services
are omitted. The snapshot's six relay authorities are kept intact. `people-collators.mjs` uses
the fork's Alice sudo key to extend People Aura, session and invulnerable storage to
the two dev keys. This is test setup in the disposable fork, not the production
collator onboarding procedure. The script verifies the existing authority before
changing it and reads the resulting authority set back at finality.

The runner needs root access to `tc` and kernel netem support. The wrapper discovers
this run's P2P ports, refuses to replace an existing custom loopback qdisc, and removes
only its own qdisc. Cleanup stops only this run's network process group. The workflow
uploads logs, configuration, observations and traffic-control counters even on failure.

The former multi-runner jobs have been removed: private connections between the
runners timed out. This workflow needs no connections between CI runners.

## Monitoring

`metrics.py sample` runs in the background for the whole job. Every five seconds it saves each
node's Prometheus metrics to `node-metrics.jsonl`, tagged with the current phase. It also reads
every finalised People block (`--chain 1502`) and saves its extrinsic count, extrinsic bytes and
consumed weight (`System::BlockWeight`, per dispatch class) to `blocks.jsonl`.

`metrics.py summarise` writes `metrics-summary.json` and `metrics-summary.md`, and the workflow adds
the Markdown to the job summary. Per phase and node it reports:

| Question | Signals |
| -------- | ------- |
| Does the transaction pool keep up? | Ready-pool peak and time to drain; dropped, invalid, usurped and finality-timeout events; validation backlog; submission-to-ready, in-block and finalised times measured by the node |
| Is block production the limit? | Why each block proposal ended (for example `hit_block_weight_limit`); transactions per block; proposal time; per-block extrinsics, bytes, normal-class ref time and proof size |
| Do finality and the relay keep up? | PVF execution and queue time; approval and dispute finality lag; unapproved candidates |
| Are the nodes healthy? | Resident memory; block import time; metric fetch errors |

Metrics that no node exposes are listed as missing rather than omitted. The node's
`rpc_transaction_*` histograms only count the `transactionWatch` RPC, so drivers using
`author_submitAndWatchExtrinsic` must read the `substrate_sub_txpool_timing_event_*` histograms
instead. Consumed weight is the declared weight of dispatched calls, not measured execution time.

The summary also reads saved artifacts. For a Coinage burst artifact, window it to each stage from
its `<stage>-summary.json`:

```sh
python3 ci/previewnet/metrics.py summarise --directory path/to/artifact --stage smoke --stage burst
```

Offline checks (Python 3.11+):

```sh
python -m pip install tomli-w==1.2.0
python -m unittest discover -s ci/previewnet -p 'test_*.py' -v
```

References: [engine fork runbook](https://github.com/paritytech/previewnet-engine/blob/7907a3bfa7b2e47535a74b7920086a05ca94773a/docs/FORK.md),
[DIM2 stress runner](https://github.com/paritytech/individuality/pull/1187),
[initialisation tests](https://github.com/paritytech/individuality/pull/1170).
