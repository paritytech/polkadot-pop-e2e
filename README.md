# polkadot-pop-e2e

End-to-end tests for the Polkadot proof-of-personhood stack, and the release gate
that runs them against a fork of a live network before anyone deploys.

The suite spans the whole flow rather than one chain: the relay, Asset Hub, People
and Bulletin, plus the identity backend that attests a person. Most of what it
checks is personhood-gated — allowances, PoP-gated contract calls, alias claims,
statement publishing, ring inclusion — so it exercises the parts that only break
when several pieces disagree.

It runs in two modes against the same tests:

- **Live** — point it at a testnet and assert the deployed thing works. This is
  what a scheduled health check does.
- **Forked** — spawn a fork of a live network, upgrade it to a candidate runtime
  or binary, and assert it still works. This is the release gate: it answers
  "would this upgrade break production" before production finds out.

## Quick start

```bash
pnpm install
NETWORK=previewnet pnpm --filter @pop-e2e/chain-tests test:network-health
```

`previewnet` needs no secrets — `//Alice` is pre-funded there. Other live networks
need `TEST_MNEMONIC` set to a funded account; see
[`packages/chain-tests/.env.example`](packages/chain-tests/.env.example).

Networks are defined in
[`packages/chain-tests/src/config/networks.ts`](packages/chain-tests/src/config/networks.ts).
Each declares its endpoints and which runtime features it carries, and tests skip
the features a network does not have.

## Running against your own network

Set `NETWORK=local-fork` and point the `FORK_*` variables at your endpoints — the
config derives everything else from the network you forked:

```bash
NETWORK=local-fork FORK_OF=previewnet \
  FORK_ASSET_HUB_WS=ws://127.0.0.1:10020 \
  FORK_PEOPLE_WS=ws://127.0.0.1:10010 \
  FORK_BULLETIN_WS=ws://127.0.0.1:10030 \
  pnpm --filter @pop-e2e/chain-tests test:network-health
```

On a fork `//Alice` is funded and holds sudo, and the engine spawns a local
identity backend — so the full suite runs with no secrets at all.

## The release gate

[`.github/workflows/release-gate.yml`](.github/workflows/release-gate.yml) forks a
network, converges every chain to the pins in its manifest, and runs the suite
against the result. Byte-identical pins no-op, so a steady-state run is an
assertion that the recorded state still holds; a pin older than production fails
rather than rolling the fork backwards.

Three ways to start one:

- **A PR editing `environments/networks/*.json`** — the diff is the ask, and
  merging it records the new state as deployed.
- **Actions → Release Gate → Run workflow** — a form, one field per pin.
- **From another repo's CI**, when it cuts a release:

  ```yaml
  uses: paritytech/polkadot-pop-e2e/.github/workflows/release-gate.yml@main
  with:
    # One runtime is baked into several networks — name them all and each gets
    # its own fork, diffed against its own deployed pin.
    environment: previewnet,paseo-next-v2
    advanced: >-
      {"chains":{"asset-hub":{"runtime":"OWNER/REPO@TAG"},
                 "people":{"runtime":"OWNER/REPO@TAG"}}}
    runs_on: parity-large       # your own label; a fork needs real capacity
  secrets:
    GH_PAT: ${{ secrets.YOUR_READ_TOKEN }}
  ```

  A reusable workflow runs on the **caller's** runners, so `runs_on` is a label
  from your org, not this one. It defaults to `parity-large`; `ubuntu-latest`
  works too — a full run finished on one in 32 minutes.

  A pin a named network does not carry fails that network's run, naming the chain,
  rather than silently skipping it.

See [`environments/README.md`](environments/README.md) for how manifests, the
release map and the candidate matrix work.

## Repository layout

```
packages/chain-tests/   the suite — vitest, endpoint-agnostic
packages/papi/          generated PAPI descriptors, refreshed daily
environments/           release map, resolver, and one manifest per network
.github/workflows/      release gate, baseline scan, PAPI refresh
```

Two workflows keep the repo honest without anyone tending it: **baseline scan**
reads each live chain's runtime every few hours and opens a PR when the manifests
drift from production, and **PAPI refresh** regenerates descriptors against current
chain metadata.

## Security

This code is **not audited**. It is test tooling: it drives networks, signs
transactions with test accounts, and is meant for testnets and forks. Do not use
it as a dependency in production, and do not point it at an account holding real
value — `TEST_MNEMONIC` should always name a throwaway.

Secrets are read from the environment and are never committed. Nothing in this
repo needs a credential to run against a public testnet or a local fork.

Report a vulnerability through the process in
[paritytech/.github](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## Licence

Apache-2.0 — see [LICENSE](LICENSE).
