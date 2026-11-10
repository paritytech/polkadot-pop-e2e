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
[`packages/chain-tests/src/config/stack-config.ts`](packages/chain-tests/src/config/stack-config.ts).
Each names where its operator publishes its [Trinity stack descriptor](https://github.com/paritytech/trinity-user-agents/blob/main/docs/rfcs/trinity-stack-descriptor.md),
with the key it is signed with, and which runtime features it carries. The suite reads the
chains, the HOP endpoint, the identity backend and the IPFS gateway from that descriptor, and
tests skip the features a network does not have.

## Running against your own network

Set `STACK` to another stack's descriptor URL or stack link, such as a fork's, to run a
network's suite against it. The network is `NETWORK`, or else the one the stack is an instance
or a fork of: the network publishing at the stack's URL or its `fork.of`, or the one its `id`
is (`previewnet-fork` is a fork of `previewnet`).

```bash
STACK=http://127.0.0.1:8090/.well-known/trinity-stack.json \
  pnpm --filter @pop-e2e/chain-tests test:network-health
```

On a fork `//Alice` is funded and holds sudo, so the full suite runs with no secrets at all.
Attestation works only on a stack with its network's genesis, such as a fork: truapi-host
checks each chain against its preset's genesis hash, so it rejects a staging instance started
from its own genesis. Tests that use an identity backend skip when the stack doesn't list one.

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
  ```

  A reusable workflow runs on the **caller's** runners, so `runs_on` is a label
  from your org, not this one. It defaults to `parity-large`; `ubuntu-latest`
  works too — a full run finished on one in 32 minutes.

  A pin a named network does not carry fails that network's run, naming the chain,
  rather than silently skipping it.

When a run fails, its summary also says which runtime change most likely caused
it. That is a diff of the forked runtime against the candidate, limited to what
product-sdk uses, with each failing test placed next to the entry its error names.

See [`environments/README.md`](environments/README.md) for how manifests, the
release map, the candidate matrix and the runtime diff work.

### Testing a runtime change against an unreleased product-sdk or truapi fix

The suite runs on the product-sdk packages and the truapi release that
`packages/chain-tests/package.json` pins. A gate run can swap them, through
inputs of the workflow call, fields of the dispatch form, or fields of the
*Release gate request* issue form. They combine with the runtime fields:

- `product_sdk`: npm specs separated by spaces, e.g.
  `@parity/product-sdk-individuality@0.10.1-dev.453.0`. Each package is replaced
  everywhere it is installed, including inside other SDK packages.
- `truapi`: a `@parity/truapi` release or prerelease. The gate installs the
  `truapi-host` CLI released with it.

The run summary lists every product-sdk and truapi version under test. A
product-sdk build whose API no longer matches the tests fails before the fork
starts, with the type errors.

When a runtime change breaks product-sdk or truapi on purpose:

1. The runtime PR's gate run fails. The runtime team opens an issue on
   [product-sdk](https://github.com/paritytech/product-sdk) or
   [trinity-user-agents](https://github.com/paritytech/trinity-user-agents) with
   the runtime build and the failing tests.
2. The platform team fixes it in a PR, publishes a prerelease of the fix, and
   adds the prerelease version to the issue.
3. The runtime team reruns its gate with that prerelease, either in its PR's
   gate call, next to the runtime it builds:

   ```yaml
   uses: paritytech/polkadot-pop-e2e/.github/workflows/release-gate.yml@main
   with:
     environment: previewnet,paseo-next-v2
     runtime_asset_hub: artifact:e2e-runtime-wasm
     runtime_people: artifact:e2e-runtime-wasm
     product_sdk: "@parity/product-sdk-individuality@0.10.1-dev.453.0"
   ```

   or from the dispatch form here, with the runtime's nightly tag and the
   prerelease. The override comes out of the runtime PR before it merges.
4. The platform team runs the dispatch form with only `product_sdk` or `truapi`
   filled, which tests the fix against the live runtimes.
5. product-sdk or truapi releases the fix. Dependabot moves the pin here a day
   later, and the `@parity` group PR merges once a code owner approves it. The
   runtime PR's gate then passes without overrides, and the runtime can be
   released and enacted.

## Repository layout

```
packages/chain-tests/   the suite — vitest, endpoint-agnostic
packages/load-tests/    Jollity-shaped load on the People chain: statement store, host, chain
packages/papi/          generated PAPI descriptors, refreshed daily
environments/           release map, resolver, and one manifest per network
.github/workflows/      release gate, baseline scan, PAPI refresh, load test
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
repo needs a credential to run against a public testnet or a local fork, except
a load test on a live network, which signs as root with that network's
`SUDO_URI` from the `load-<network>` GitHub environment.

Report a vulnerability through the process in
[paritytech/.github](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## Licence

Apache-2.0 — see [LICENSE](LICENSE).
