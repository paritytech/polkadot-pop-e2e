# Environments — canonical state (X) and test targets (Y)

**`<network>.json` on the main branch is the canonical state X**: what we believe is *deployed right now* — which binaries each chain runs, which runtime, which services. **The ask (Y) is a diff against it**, arriving through any of three doors:

1. **A PR editing the manifest** — the diff *is* the ask, and the PR *is* the target's lifecycle: the gate runs on it, results accumulate on it, and **merging it is the promotion** — done only after the real network has migrated, so main always describes deployed reality. (A promotion merged too early is self-evident: its gate run shows a real upgrade executing instead of all no-ops.)
2. **Actions → Release Gate → Run workflow** with the `target` input — a sparse JSON overlay naming only the pins to test; ephemeral, nothing recorded but the run:

   ```json
   { "chains": { "bulletin": { "runtime": "paritytech/polkadot-bulletin-chain@v0.0.23-paseo" } } }
   ```
3. **An issue** from the *Release gate request* template — same overlay in a form; a bot validates it, dispatches the gate, and comments the run link back. (This is also the hook for a future GH Pages UI: render the canonical pins, let the user pick targets, and open a prefilled issue — no tokens in the page.)

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

Each candidate ends by running the manifest's `tests:` — `pnpm --filter @triangle-e2e/chain-tests <script>` per entry, with `NETWORK=local-fork` — against its upgraded fork; that suite is the actual verdict on the environment.

The engine's own pins are its business (per-network `networks/<name>.json` after preview-net-v1 #159; `config/versions.env` keeps only the shared toolchain); this directory answers "what is deployed as we know it" (canonical) and "what is being asked" (target).

## Entry points

- **PR touching `environments/**`** — the normal path; review the pin bump, CI gates it.
- **Actions → Release Gate → Run workflow** — ad-hoc runs; `ppn_ref` picks the engine ref (defaults to preview-net-v1 `main`). A future UI needs nothing more than these two: render the manifest, write the PR or fire the dispatch.
- **Locally** — resolve, then drive the engine by hand:

  ```bash
  pnpm resolve:environment overrides environments/networks/previewnet.json  # engine env (PPN_BINARIES, NETWORK, ...)
  pnpm resolve:environment runtimes environments/networks/previewnet.json   # downloads, prints chain=path
  # in a preview-net-v1 checkout: make start FORK=1 → make runtime-upgrade per line
  NETWORK=local-fork pnpm --filter @triangle-e2e/chain-tests test:network-health
  ```

## Binary slots and chain pins

Binaries are pinned **once per engine binary slot**; runtimes **per chain**:

```json
"binaries": {
  "polkadot":           "paritytech/preview-net-v1@vX",
  "polkadot-omni-node": "paritytech/preview-net-v1@vX"
},
"chains": {
  "relay":     { "runtime": "paritytech/preview-net-v1@vX" },
  "asset-hub": { "runtime": "paritytech/individuality@vY" },
  "bulletin":  { "runtime": "paritytech/polkadot-bulletin-chain@v0.0.23-paseo" }
},
"services":  { "eth-rpc": "…", "identity-backend": "…", "storage-provider-node": "…", "kubo": "…" }
```

**Which binary *file* a chain execs is engine wiring, not a manifest choice** — relay → `polkadot`, every previewnet parachain → `polkadot-omni-node`, mirrored as read-only fact in the map (`CHAINS.<network>.<chain>.node` in `release-map.mjs`). The engine keeps one file per slot, so the manifest pins the slot, not the chain: a split pin ("bulletin on X, people on Y") is inexpressible rather than merely rejected, and if the engine ever rewires a chain to a different binary, no manifest changes — only the map does. On kusama/polkadot, where parachains genuinely run different node binaries (`polkadot-parachain` vs omni-node), the slots differ per chain in the map and each slot gets its own pin.

A slot may come from **any repo in its allow-list**: preview-net-v1, polkadot-sdk and release-automation publish `polkadot` (+ its ABI-coupled PVF workers, which always travel with it), `polkadot-omni-node` and `eth-rpc` under the same asset-name convention, so `"polkadot-omni-node": "paritytech/polkadot-sdk@polkadot-stable2606-1"` is a legal manifest change. Whether that source can actually *drive* the network (host functions, features) is what the gate run answers — that's the point. (release-automation caveat: some of its releases are partial re-publishes — pin a complete tag, never `latest`.)

**Delivery is declared, not smuggled**: slot and eth-rpc pins become `PPN_BINARIES` overrides (`resolve.mjs overrides`), applied inside the engine's loader so `fetch`, `start` and `ppn show --json` cannot disagree; the gate asserts the resolved `show --json` against the manifest (`assert-engine.mjs`) before spawning — every pin must come back marked `overridden`, and the chain→binary wiring we mirror in the map for ask-time validation is checked against the engine's own answer on every run.

Runtimes are allow-listed the same way, with the asset name looked up **per repo** (naming conventions differ): previewnet's people and asset-hub runtimes may pin `paritytech/preview-net-v1` (PPN's re-publish, plain `.wasm`) or `paritytech/individuality` (the upstream source of the next-* runtimes, `.compact.compressed.wasm`) — so gating `paritytech/individuality@v0.11.2` before PPN ever re-publishes it is one manifest line. Bulletin and web3-storage already pin their upstream repos directly.

`identity-backend` pins the identity service quadruple (identity-api, identity-chain-writer, registration-queue, username-indexer — they travel together), shipped on `paritytech/device-uniqueness-backend`'s own releases since its v0.2.0. Delivery is the engine's `DUB_TAG` env var (the repo is engine wiring); the resolver's `overrides` mode emits it alongside `PPN_BINARIES`, so nothing is file-replaced anymore.

Deliberately **not** pinnable: the engine's own machinery — `zombie-cli`, doppelganger (bite-time only), the portable Postgres the identity services use, `chain-spec-builder` (genesis mode only; a fork uses the bundle's specs). Those version the *engine*, not the environment under test, and stay pinned in preview-net-v1's `versions.env`.

## Current limitations

- Only `base: fork` and only previewnet. The `kubo` and `storage-provider-node` pins are recorded but not yet deliverable (per-platform tarballs the engine self-extracts); the engine uses its own defaults for them.
- Non-chain components beyond the pinned services (dotli, the host apps) are not gateable yet; the map's shape is where they will go.
- `secrets.GH_PAT` must be able to read preview-net-v1 (code and releases) — plus any other private repo the manifest pins releases from (e.g. `paritytech/individuality`, `paritytech/release-automation`).

## preview-net-v1 #159 (multi-network workspace) — integrated

The gate targets PPN's multi-network API: PPN stopped building anything itself — binaries come from `paritytech/release-automation` (weekly cuts from polkadot-sdk master), runtimes from their upstreams, the identity quadruple from `paritytech/device-uniqueness-backend` — and the engine is driven through the `ppn` CLI. What that means here:

- Canonical pins point at the real sources: binaries + eth-rpc from release-automation, relay runtime from `paseo-network/runtimes`, asset-hub/people from `individuality`, bulletin/web3-storage from their repos, identity-backend from `device-uniqueness-backend`.
- Binary delivery = `PPN_BINARIES` overrides + the `assert-engine.mjs` pre-spawn check (see "Delivery is declared" above). No files are pre-seeded except the identity quadruple, which has no override channel yet.
- `PPN_REF_DEFAULT` is the `multi-network-workspace` branch until #159 merges — then flip to `main`.
- Still deliberately ours: the **downgrade guard** (`ppn upgrade` reports and applies downgrades without refusing) and per-chain exact runtime asset names (`ppn upgrade` does not check a blob belongs to the chain it's fed to).
- Later: replace the map's mirrored wiring with `@parity/ppn-network-config` once it's on npm (until then the runtime drift assert keeps the mirror honest); publish pnv2 fork bundles so its gate stops biting live; a full raw Paseo Asset Hub spec to unblock devnet.
