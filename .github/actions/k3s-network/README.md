# k3s-network

Starts a zombienet network on the runner with every node on CPU cores of its
own, so one node's load cannot slow another and performance numbers mean
something. It installs K3s with the static CPU manager, starts the network with
zombienet's k8s provider (one pod per node), and fails if any node ended up on
shared CPUs.

It is a composite action, not a reusable workflow, so the network runs in your
job and your own steps (tests, load generators) can reach it afterwards.

## Use

```yaml
jobs:
  e2e:
    runs-on: parity-large          # needs sudo; Linux x86_64
    steps:
      - uses: actions/checkout@v4

      - uses: ./.github/actions/k3s-network
        # from another repo:
        # uses: paritytech/polkadot-pop-e2e/.github/actions/k3s-network@main
        env:
          POLKADOT_IMAGE: docker.io/parity/polkadot:v1.25.0   # fills {{POLKADOT_IMAGE}}; pin it
        with:
          network: path/to/network.toml
          chains: alice my-collator    # wait until these finalize a block

      # Your steps. kubectl works, $NAMESPACE is set, and each pod's RPC is at
      # http://<pod IP>:9944:
      #   kubectl -n "$NAMESPACE" get pod alice -o jsonpath='{.status.podIP}'
      - run: ./run-my-tests.sh

      - uses: ./.github/actions/k3s-network/collect-logs
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: network-logs, path: logs }
```

## Inputs

| input | default | |
|---|---|---|
| `network` | (required) | zombienet TOML. `{{NAME}}` is replaced with env var `NAME`. |
| `namespace` | `zombienet` | Kubernetes namespace for the pods. |
| `reserved-cores` | `2` | Physical cores, from core 0, kept for the OS, K3s and zombie-cli. |
| `zombie-cli-version` | `v0.4.15` | zombienet-sdk release. |
| `spawn-timeout-minutes` | `15` | How long to wait for every node to be running. |
| `chains` | (none) | Pods to check finalize blocks, one per chain. Empty skips it. |
| `soak-minutes` | `0` | After the first finalized block, keep watching this long and fail on a stall. |

## Writing the network TOML

A node only gets its own cores if, in the TOML:

- it sets `resources.requests` **equal to** `resources.limits`, for both `cpu`
  and `memory`. Set them per node: zombienet-sdk v0.4.15 ignores
  `relaychain.default_resources` on k8s;
- its `cpu` is a whole number of physical cores. On `parity-large` (16 cores, 2
  threads each) that means an even number.

All nodes together must fit in what is left after `reserved-cores`: on
`parity-large` with the default, 28 vCPU. If they do not, a pod will not start
and the spawn times out. `.github/k3s/network.toml` is a worked example with
the sizing written out.

`check-cores.sh` finds the nodes by their `name = "..."` lines, so give every
node an explicit name (no `collator_groups` with a count).
