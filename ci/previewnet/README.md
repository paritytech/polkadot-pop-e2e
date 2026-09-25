# Previewnet across CI runners

This is a readiness check for later Coinage load tests. It starts one forked Previewnet
across **two `parity-large` runners**, then repeats on **three**. No top-ups are submitted.

The engine is checked out at `7907a3b`. Its published Previewnet snapshot is downloaded
once per workflow run. The snapshot, six validator identities and raw chain specs are
shared by all workers. Each node runs in exactly one worker's native Zombienet process.

| Layout | Runner 0 | Runner 1 | Runner 2 |
| ------ | -------- | -------- | -------- |
| Two | Alice, Charlie, Eve; Asset Hub, Bulletin | Bob, Dave, Ferdie; People, Web3 Storage | — |
| Three | Alice, Dave; Asset Hub, Web3 Storage | Bob, Eve | Charlie, Ferdie; People, Bulletin |

## Run

Use **Previewnet multi-runner readiness**, select this branch, and enable `run_nodes`.
Branch pushes run connectivity checks only. The full run proceeds through:

1. Offline tests, then two-runner private connectivity and distinct-machine checks.
2. Download shared snapshot and pinned binaries. Save release asset IDs and SHA-256 hashes.
3. Start the two-worker network, connect validator peers, and check continuing finality.
4. Only after success, start the three-worker network from the same snapshot.

The engine generates the fork TOML. `topology.py` assigns its nodes to workers, changes
advertised P2P addresses to their private IPs, and points each collator at a local relay RPC.
Product services are omitted. Runtime versions come from the snapshot; there is no runtime
upgrade or Coinage fixture setup here. Node binaries follow `environments/networks/previewnet.json`.

## Required runner network

Workers must be separate machines with routable private IPv4 addresses. They need concurrent
runner capacity: two jobs, then three. Private TCP **30334–30339** carries validator traffic.
The connectivity probe uses 30334 and stops before Zombienet starts. Collators use the separate P2P range **30400–30403**. Permit those between these test runners too.
RPC and metrics are queried locally; no public ingress or VPN credentials are required.

The workflow does not change firewall rules. A failed probe prevents node startup.
Diagnostics include interface addresses, routes, listening sockets and local firewall rules.
Distinct kernel boot IDs establish separate VMs/kernels, not physical hypervisor placement.

## What passes

- Every local relay validator sees a known peer from each other worker.
- All six validators and all four parachains advance at least three finalised blocks beyond
  both their initial observation and the snapshot height, over at least a 30-second observation.
- All validators agree on a checkpoint hash after the fork point.

An open RPC, a nonzero height, advancing best blocks, or local-only peers cannot pass.
Startup and finality waits are bounded. Failure preserves logs, per-node samples, generated
TOML, provenance and available Prometheus data. Cleanup signals only this run's process group.
The checks establish readiness; they make no throughput, weight-accuracy or PVF-capacity claim.

## Validation status

The two-runner probes in [run 36106909735](https://github.com/paritytech/polkadot-pop-e2e/actions/runs/36106909735)
reached themselves but timed out reaching one another on private TCP 42420. Local input/output
firewall policies were permissive. The probe now uses the actual relay P2P port, 30334.
Distributed block production remains unverified until connectivity and the full node run pass.

For local offline checks (Python 3.11+):

```sh
python -m pip install tomli-w==1.2.0
python -m unittest discover -s ci/previewnet -p 'test_*.py' -v
```

References: [DIM2 stress runner](https://github.com/paritytech/individuality/pull/1187),
[initialisation tests](https://github.com/paritytech/individuality/pull/1170),
and the [engine fork runbook](https://github.com/paritytech/previewnet-engine/blob/7907a3bfa7b2e47535a74b7920086a05ca94773a/docs/FORK.md).
