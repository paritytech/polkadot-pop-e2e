# People flood

PolkaMeter 0.4.0 controls submission, probes, recovery, metrics and loss accounting.
The TypeScript plugin in `packages/chain-tests/src/stress` reuses the suite's
People signer, ring reads, product contexts and WASM loader. It prepares sudo
recognition and distinct proof-authorized statement-store claims/probes as
checksummed artifacts. Proofs run in at most eight worker threads.

Run the **Stress · flood** workflow on this branch. It bites a fresh previewnet
fork with three People cores and five collators, then runs the one plan:
750 people × 20 slots, ramping from 6 tx/s by 4 tx/s for ten 60-second stages.
`fail-on: error` reports degradation without treating the load verdict as a gate.
For smoke, edit the plan to 40 people × 12 slots and three 30-second rates
at 2, 4 and 6 tx/s; use three baseline probes and 120 seconds of recovery.
Keep `block-interval-seconds="2"` for previewnet.

Locally, with Node 22+, pnpm and PolkaMeter on PATH:

```sh
pnpm install --frozen-lockfile
polkameter plugin install stress/people-plugin.sh
polkameter validate stress/plans/people-default.polkameter.xml
polkameter plugin credential previewnet-sudo POLKAMETER_SETUP_SURI
polkameter plugin topology previewnet /path/to/zombie.json
POLKAMETER_SETUP_SURI=//Alice polkameter run stress/plans/people-default.polkameter.xml --output stress-results --fail-on error
```

Use only a disposable sudo-enabled fork. The preflight is read-only; setup returns
recognition transactions for `core.submit-setup` to finalize before ring reads.
Preparation rejects runtime/UTC-day changes and duplicate transactions.
No Recycler observer or allowance-state checker is included; PolkaMeter records
finality, dispatch failures and transaction loss. Protocol tests run in CI:

```sh
node --import tsx --test packages/chain-tests/src/stress/*.test.ts
node --import tsx packages/chain-tests/src/stress/benchmark.ts
```
