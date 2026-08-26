# @pop-e2e/chain-tests

Vitest suite that hits the testnet chains directly — Asset Hub, People, Bulletin — plus the Identity Backend. Used by CI on a schedule (Network Health, Ring Health workflows) and locally for debugging.

## Quick start

```
pnpm install
pnpm --filter @pop-e2e/chain-tests test            # full network-health on paseo-next-v2
NETWORK=previewnet pnpm --filter @pop-e2e/chain-tests test    # switch network
```

## Scripts

| Script | What it does |
|---|---|
| `test` | Full network functional health suite (core, allowances, statement, storage, dotns, IB-health probe) |
| `test:ring-health` | People-chain ring-builder rebuild-latency probe only |
| `test:ib-health` | Identity Backend ASSIGNED-within-budget probe only |
| `deploy-counter` | Idempotently deploy the counter contract used by the PGAS-paid Revive test |
| `papi` | Re-generate PAPI descriptors from committed `.scale` metadata |

## Network selection

`NETWORK` env var selects which entry from `src/config/networks.ts` to use:

- `paseo-next-v2` (default) — public testnet on Polkadot.io endpoints
- `previewnet` — dev testnet on substrate.dev, Alice-funded

## Tests

| File | What it tests |
|---|---|
| `core.test.ts` | Asset Hub is producing finalised blocks, test account funded, `System.remark` includes |
| `allowances.test.ts` | PGAS claim → Revive contract call paid in PGAS |
| `statement.test.ts` | Statement Store write + read against People chain after IB attestation |
| `storage.test.ts` | LTS allowance claim on People → XCM to Bulletin → upload + IPFS retrieve |
| `dotns.test.ts` | DotNS resolution on Asset Hub |
| `probes/ib-health.test.ts` | IB attestation reaches `ASSIGNED` within poll budget (gates everything else) |
| `probes/ring-health.test.ts` | People-chain ring-builder produced rebuilds in last 200 blocks |

The IB-health probe runs first; if it fails, dependent suites short-circuit via the cascade marker in `src/lib/attested-fixture.ts`. Same shape for ring failures in `src/lib/ring.ts`.

## Reporting

`scripts/render-summary.py` produces the GitHub Actions step summary and the Matrix notification body. Defensive against empty / malformed junit (so a vitest SIGKILL still results in a notification).

`scripts/parse-ring-health.py` + `scripts/diff-ring-health.py` drive the ring-health probe's state-change detection — only notifies the Matrix room when the verdict changes (with a consecutive-fail debounce to absorb RPC flakes).

## Test results

`test-results/junit.xml` is consumed by CI. `test-results/curr-state.json` (ring-health) carries the probe state across cron runs via the GitHub Actions cache.
