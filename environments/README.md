# Environments — canonical state (X) and test targets (Y)

**`<network>.json` on the main branch is the canonical state X**: what we believe is *deployed right now* — which binaries each chain runs, which runtime, which services. **The ask (Y) is a diff against it**, arriving through any of three doors:

1. **A PR editing the manifest** — the diff *is* the ask, and the PR *is* the target's lifecycle: the gate runs on it, results accumulate on it, and **merging it is the promotion** — done only after the real network has migrated, so main always describes deployed reality. (A promotion merged too early is self-evident: its gate run shows a real upgrade executing instead of all no-ops.)
2. **Actions → Release Gate → Run workflow** — a form, one field per override: pick the environment, type the pins you want tested (`owner/repo@tag`), leave the rest empty and they stay canonical. Ephemeral, nothing recorded but the run.
3. **An issue** from the *Release gate request* template — the same fields, in an issue; a bot validates them, dispatches the gate, and comments the run link back. (This is also the hook for a future GH Pages UI: render the canonical pins, let the user pick targets, and open a prefilled issue — no tokens in the page.)

Doors 2 and 3 share one field list, [`gate-form.mjs`](./gate-form.mjs), which assembles the typed pins into the sparse overlay everything downstream consumes:

```json
{ "chains": { "bulletin": { "runtime": "paritytech/polkadot-bulletin-chain@v0.0.23-paseo" } } }
```

Pins are `owner/repo@tag`. **`@latest`** is accepted everywhere and resolves through the repo's GitHub *latest release*, with the run log naming the concrete tag — safe on `polkadot-sdk`, `release-automation`, `web3-storage` and `device-uniqueness-backend`, but a trap on three sources (verified 2026-08-25):

| Source | `@latest` resolves to | Why it bites |
|---|---|---|
| `paseo-network/runtimes` | `v2.4.3` | Behind the deployed `v2.4.4` — GitHub ranks `releases/latest` by tag `created_at`, not publish date, so the gate rejects it as a downgrade |
| `paritytech/individuality-community` | `404` | Every release is a prerelease nightly, and `releases/latest` skips prereleases |
| `polkadot-bulletin-chain`, `individuality` | whichever flavor sorts first | Flavor-blind — `individuality@latest` is the `-previewnet` build, wrong for paseo-next-v2; bulletin can land a westend build |

Both doors also carry an **advanced** raw-overlay field for the asks no field expresses — a different `tests` list, `asset-hub` pinned apart from `people`, or a `ppn_ref` naming the previewnet-engine branch to take the engine from. When filled it *replaces* the fields. Two notes on the field list: `workflow_dispatch` accepts at most 10 inputs, which is why asset-hub and people share one `individuality` field (two runtimes out of one build — they have never been pinned apart), and why `ppn_ref` rides in the advanced overlay rather than owning a slot.

Whichever door: the gate forks the live network, converges X → Y — swapping/upgrading **only what differs** (identical pins byte-compare and no-op), never downgrading — runs the chain-tests, and the run summary leads with the exact transitions tested (`bulletin: runtime …v0.0.22-paseo → …v0.0.23-paseo`).

Gated networks: **previewnet** (published fork bundle) and **paseo-next-v2** (`FRESH_BITE=1` — no published bundle, the gate bites live pnv2 at run time; the engine's shared-relay fixes replan the cores onto the fork's 6 validators and endow sudo at import, full E2E proven 2026-08-19). **devnet** is mapped but cannot be bitten yet (`NETWORK_META.gateable: false`): only the smol Paseo Asset Hub chain-spec is published (stateRootHash genesis) and doppelganger rejects it — "Genesis storage in hash format not supported", verified 2026-08-19; a full raw spec has to be sourced or generated first. Kusama and Polkadot have engine descriptors but stay out until a sudo-less enactment path exists (their converge cannot use sudo). Adding a network = one manifest + one `CHAINS`/`SERVICES`/`NETWORK_META` entry in `release-map.mjs`. The chain-tests side needs one base `NETWORKS` entry per network — `NETWORK=local-fork` then derives the fork config from it (the manifest's `network` field, passed as `FORK_OF`): capability flags and chain set are inherited, only the transport is swapped to the engine's local ports. pnv2/devnet forks run no identity backend (their engine descriptors spawn only eth-rpc beside the chains), so the workflow exports `FORK_IDENTITY_BACKEND=none` and attestation-dependent tests skip; devnet's manifest also leaves `bulletin` unpinned — its deployed build (spec 2003001) is on no public release, so the fork keeps it as bitten.

## How a gate runs

The workflow (`.github/workflows/release-gate.yml`) **converges, it does not diff-parse**:

1. Fork the live network from the engine's published bundle and spawn it on the manifest's **binary** pins. The fork's state carries whatever runtimes production runs — the "from" side (X) is never declared in the manifest, the bundle is its source of truth, and the run summary reports the observed `X → Y` per chain.
2. For every chain, download the pinned **runtime** (Y — always the *target*, never a claim about what's there) and run the engine's `make runtime-upgrade`. Byte-identical to what the fork runs → built-in no-op (`already-installed`), which in steady state is an *assertion* that the gated record still matches production; different → a real on-chain upgrade, enacted and verified; **lower** → the gate fails, the manifest fell behind production.
3. Run the manifest's `tests:` (chain-tests scripts) with `NETWORK=local-fork`.

So the target file *is* the test plan, with no mode flags — and a target that moves **both** dimensions fans out into a candidate matrix, one fork run each:

| candidate | configuration | answers | gates the PR? |
| --- | --- | --- | --- |
| `target` | new binaries + new runtimes, rollout order | the declared Y state | **yes** |
| `binaries-only` | new binaries × canonical runtimes | can the fleet upgrade binaries under the running runtime? | informational |
| `runtimes-only` | canonical binaries × new runtimes | does the runtime enact without the binary bump, or is binary-first mandatory? | informational |

Single-dimension targets collapse to just `target` (a binaries-only ask is then itself the mixed-version rollout test — every runtime converge no-ops; a runtimes-only ask is the pure upgrade gate). The cross terms are rollout-*ordering* findings — a red `runtimes-only` means "don't enact until every node runs the new binary", not "don't merge". One PR may carry targets for several networks; each fans out its own candidates, all in parallel.

Each candidate ends by running the manifest's `tests:` — `pnpm --filter @pop-e2e/chain-tests <script>` per entry, with `NETWORK=local-fork` — against its upgraded fork; that suite is the actual verdict on the environment.

The engine's own pins are its business (per-network `networks/<name>.json`; `config/versions.env` keeps only the shared toolchain); this directory answers "what is deployed as we know it" (canonical) and "what is being asked" (target).

## Entry points

- **PR touching `environments/**`** — the normal path; review the pin bump, CI gates it.
- **Actions → Release Gate → Run workflow** — ad-hoc runs; one field per pin, plus an advanced overlay whose `ppn_ref` key picks the engine ref (defaults to previewnet-engine `main`). A future UI needs nothing more than these two: render the manifest, write the PR or fire the dispatch.
- **Locally** — resolve, then drive the engine by hand:

  ```bash
  pnpm resolve:environment overrides environments/networks/previewnet.json  # engine env (PPN_BINARIES, NETWORK, ...)
  pnpm resolve:environment runtimes environments/networks/previewnet.json   # downloads, prints chain=path
  # in a previewnet-engine checkout: make start FORK=1 → make runtime-upgrade per line
  NETWORK=local-fork pnpm --filter @pop-e2e/chain-tests test:network-health
  ```

## Binary slots and chain pins

Binaries are pinned **once per engine binary slot**; runtimes **per chain**:

```json
"binaries": {
  "polkadot":           "paritytech/release-automation@vX",
  "polkadot-omni-node": "paritytech/release-automation@vX"
},
"chains": {
  "relay":     { "runtime": "paseo-network/runtimes@vX" },
  "asset-hub": { "runtime": "paritytech/individuality@vY" },
  "bulletin":  { "runtime": "paritytech/polkadot-bulletin-chain@v0.0.23-paseo" }
},
"services":  { "eth-rpc": "…", "storage-provider-node": "…", "kubo": "…" }
```

**Which binary *file* a chain execs is engine wiring, not a manifest choice** — relay → `polkadot`, every previewnet parachain → `polkadot-omni-node`, mirrored as read-only fact in the map (`CHAINS.<network>.<chain>.node` in `release-map.mjs`). The engine keeps one file per slot, so the manifest pins the slot, not the chain: a split pin ("bulletin on X, people on Y") is inexpressible rather than merely rejected, and if the engine ever rewires a chain to a different binary, no manifest changes — only the map does. On kusama/polkadot, where parachains genuinely run different node binaries (`polkadot-parachain` vs omni-node), the slots differ per chain in the map and each slot gets its own pin.

A slot may come from **any repo in its allow-list**: polkadot-sdk and release-automation both publish `polkadot` (+ its ABI-coupled PVF workers, which always travel with it), `polkadot-omni-node` and `eth-rpc` under the same asset-name convention, so `"polkadot-omni-node": "paritytech/polkadot-sdk@polkadot-stable2606-1"` is a legal manifest change. Whether that source can actually *drive* the network (host functions, features) is what the gate run answers — that's the point. (release-automation caveat: some of its releases are partial re-publishes — pin a complete tag, never `latest`.)

**Delivery is declared, not smuggled**: slot and eth-rpc pins become `PPN_BINARIES` overrides (`resolve.mjs overrides`), applied inside the engine's loader so `fetch`, `start` and `ppn show --json` cannot disagree; the gate asserts the resolved `show --json` against the manifest (`assert-engine.mjs`) before spawning — every pin must come back marked `overridden`, and the chain→binary wiring we mirror in the map for ask-time validation is checked against the engine's own answer on every run.

Runtimes are allow-listed the same way, with the asset name looked up **per repo** (naming conventions differ): previewnet's people and asset-hub runtimes may pin `paritytech/individuality-community` (the public nightlies) or `paritytech/individuality` (the upstream source of the next-* runtimes, `.compact.compressed.wasm`). Every chain now pins the repo that builds its runtime.

`identity-backend` names the identity service quadruple (identity-api, identity-chain-writer, registration-queue, username-indexer — they travel together), shipped on `paritytech/device-uniqueness-backend`'s own releases since its v0.2.0. The canonical manifest deliberately does **not** pin it: the engine's own default tag (previewnet-engine `config/versions.env`) governs the baseline, so this pin can never go stale here. A candidate override may still name it — then the resolver's `overrides` mode emits the engine's `DUB_TAG` env var alongside `PPN_BINARIES`, which is how a new dub release gets gated.

Deliberately **not** pinnable: the engine's own machinery — `zombie-cli`, doppelganger (bite-time only), the portable Postgres the identity services use, `chain-spec-builder` (genesis mode only; a fork uses the bundle's specs). Those version the *engine*, not the environment under test, and stay pinned in previewnet-engine's `versions.env`.

## Baseline scan — the record stays true without a human chasing production

The networks these manifests describe upgrade on their own schedule; a pin that was true on Monday is a lie by Friday, and the gate's downgrade guard turns that lie into a red run (observed five times in one month before this existed). `pnpm scan:baseline` closes the loop: for every pinned chain it reads the LIVE runtime — spec version, block, and the raw `:code` bytes — and attributes it to a release by **byte equality** with the release asset. Attribution is proof, never a tag-name guess. With `--write` it rewrites drifted pins; the scheduled workflow (`baseline-scan.yml`, every 6h) commits those to `baseline/bump` and keeps one auto-PR open, whose own release-gate run validates the new baseline before a human merges it.

One honest exception: the public Paseo relay is upstream-operated and its deployed blob byte-matches no published asset (same declared spec, different build). Chains marked `scanPolicy: 'spec'` in the map are compared by the RuntimeVersion the pinned artifact declares (parsed from the wasm itself — `wasm-spec.mjs`) instead of bytes, and render as `[spec]` in the summary.

The scan goes red only when a human is needed: **unattributed** (production runs bytes/spec no allow-listed release carries — someone deployed unpublished code) or an unreachable scan endpoint. Drift alone is not a failure; the auto-PR is the fix. The gate never uses the scan's endpoints — forks get state from the engine's bite; the pre-existing downgrade guard stays as the backstop for the hours between scans.

## Current limitations

- Only `base: fork` and only previewnet. The `kubo` and `storage-provider-node` pins are recorded but not yet deliverable (per-platform tarballs the engine self-extracts); the engine uses its own defaults for them.
- Non-chain components beyond the pinned services (dotli, the host apps) are not gateable yet; the map's shape is where they will go.
- `secrets.GH_PAT` must be able to read previewnet-engine (code and releases) — plus any other private repo the manifest pins releases from (e.g. `paritytech/individuality`, `paritytech/release-automation`).

## How the gate drives the engine

The engine builds nothing itself — binaries come from `paritytech/release-automation` (weekly cuts from polkadot-sdk master), runtimes from their upstreams, the identity quadruple from `paritytech/device-uniqueness-backend` — and the engine is driven through the `ppn` CLI. What that means here:

- Canonical pins point at the real sources: binaries + eth-rpc from release-automation, relay runtime from `paseo-network/runtimes`, asset-hub/people from `individuality`, bulletin/web3-storage from their repos; identity-backend rides the engine's default (`device-uniqueness-backend`, overridable per candidate).
- Binary delivery = `PPN_BINARIES` overrides + the `assert-engine.mjs` pre-spawn check (see "Delivery is declared" above). No files are pre-seeded except the identity quadruple, which has no override channel yet.
- `PPN_REF_DEFAULT` is `main`; a dispatch can pin `ppn_ref` via the advanced overlay to run against an engine branch.
- Still deliberately ours: the **downgrade guard** (`ppn upgrade` reports and applies downgrades without refusing) and per-chain exact runtime asset names (`ppn upgrade` does not check a blob belongs to the chain it's fed to).
- Later: `@parity/ppn-network-config` is on npm now, so the map's mirrored wiring can read from it instead of restating it (the runtime drift assert keeps the mirror honest until it does); publish pnv2 fork bundles so its gate stops biting live; a full raw Paseo Asset Hub spec to unblock devnet.
