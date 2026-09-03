// Which release sources provide which artifact, per network — the map behind the
// release-gate workflow. Pure logic, unit-tested in release-map.test.mjs; talking to
// the GitHub API lives in resolve.mjs.
//
// Asset names are exact, not patterns: they are release contracts, and an upstream
// rename should fail the resolution loudly rather than fuzzy-match the wrong blob
// into a chain. Adding a network (paseo-next-v2, dev-net, kusama, polkadot) means
// adding its entry here and a manifest in this directory — nothing else.

/**
 * Per network, per chain: which engine binary slot the chain's nodes run (`node`),
 * and which repos may provide its runtime (`runtime` maps allowed repo → exact asset
 * name in that repo's releases).
 *
 * `node` is engine wiring, read-only here: the engine keeps ONE file per binary slot
 * and every chain naming the same slot execs the same file. The manifest therefore
 * pins binaries once per SLOT (top-level `binaries`), not per chain — a split pin is
 * impossible by construction, and rewiring which file a chain execs (e.g. omni-node →
 * polkadot-parachain) is a map/engine change that touches no manifest. On networks
 * whose parachains run different node binaries — kusama's polkadot-parachain vs
 * omni-node — the slots simply differ per chain here and each gets its own pin.
 */
// Per-chain `ws` is the public RPC the baseline scan reads truth from (spec
// version, :code bytes). It is NOT used by the gate itself — forks get their
// state from the engine's bite.
export const CHAINS = {
  previewnet: {
    relay: {
      node: 'polkadot',
      ws: 'wss://previewnet.substrate.dev/relay/alice',
      // The _fast build (1-minute epochs), NOT paseo_runtime: previewnet was spawned
      // with fast epochs, and enacting a runtime whose BABE EpochDuration differs
      // wedges the chain on the spot — every block after the swap fails import with
      // "Expected epoch change to happen at ..." (caught live by the local gate run,
      // 2026-08-14).
      runtime: {
        'paseo-network/runtimes': 'paseo_fast_runtime.compressed.wasm',
      },
    },
    // The next-* runtimes are developed in paritytech/individuality and published on
    // paritytech/individuality-community, which is the only source pinned here: the
    // bytes are identical and the community repo is public, so a gate run needs no
    // read access to anything private.
    'asset-hub': {
      node: 'polkadot-omni-node',
      ws: 'wss://previewnet.substrate.dev/asset-hub',
      runtime: {
        'paritytech/individuality-community': 'next_asset_hub_paseo_runtime.compact.compressed.wasm',
      },
    },
    people: {
      node: 'polkadot-omni-node',
      ws: 'wss://previewnet.substrate.dev/people',
      runtime: {
        'paritytech/individuality-community': 'next_people_paseo_runtime.compact.compressed.wasm',
      },
    },
    bulletin: {
      node: 'polkadot-omni-node',
      ws: 'wss://previewnet.substrate.dev/bulletin',
      runtime: {
        'paritytech/polkadot-bulletin-chain': 'bulletin_paseo_runtime.compact.compressed.wasm',
      },
    },
    'web3-storage': {
      node: 'polkadot-omni-node',
      ws: 'wss://previewnet.substrate.dev/web3-storage',
      runtime: {
        'paritytech/web3-storage': 'storage_paseo_runtime.compact.compressed.wasm',
      },
    },
  },
  // Next runtimes as parachains on the PUBLIC Paseo relay (para band 1500-1502).
  // The relay pin is the NORMAL build — public Paseo runs 1-hour epochs, unlike
  // previewnet's fast genesis (see the previewnet relay note above).
  'paseo-next-v2': {
    relay: {
      node: 'polkadot',
      ws: 'wss://paseo-rpc.n.dwellir.com',
      // Public Paseo is upstream-operated: the deployed :code predates the current
      // release pipeline and byte-matches NO release asset (verified 2026-08-21:
      // live blob 1.98MB vs every paseo_runtime.compressed.wasm ~1.68MB, same
      // spec 2003001). The strongest honest check is spec equality, so the scan
      // compares the RuntimeVersion the pinned artifact declares, not its bytes.
      scanPolicy: 'spec',
      runtime: { 'paseo-network/runtimes': 'paseo_runtime.compressed.wasm' },
    },
    'asset-hub': {
      node: 'polkadot-omni-node',
      ws: 'wss://paseo-asset-hub-next-rpc.polkadot.io',
      runtime: {
        'paritytech/individuality-community': 'next_asset_hub_paseo_runtime.compact.compressed.wasm',
      },
    },
    people: {
      node: 'polkadot-omni-node',
      ws: 'wss://paseo-people-next-system-rpc.polkadot.io',
      runtime: {
        'paritytech/individuality-community': 'next_people_paseo_runtime.compact.compressed.wasm',
      },
    },
    bulletin: {
      node: 'polkadot-omni-node',
      ws: 'wss://paseo-bulletin-next-rpc.polkadot.io',
      runtime: {
        'paritytech/polkadot-bulletin-chain': 'bulletin_paseo_runtime.compact.compressed.wasm',
      },
    },
  },
  // The community devnet: the REAL Paseo system chains (AH 1000, People 1004) plus
  // bulletin 1010, on the public relay. Runtimes come from paseo-network/runtimes.
  devnet: {
    relay: {
      node: 'polkadot',
      ws: 'wss://paseo-rpc.n.dwellir.com',
      scanPolicy: 'spec', // same public relay as paseo-next-v2 — see that note
      runtime: { 'paseo-network/runtimes': 'paseo_runtime.compressed.wasm' },
    },
    'asset-hub': {
      node: 'polkadot-omni-node',
      ws: 'wss://asset-hub-paseo-rpc.n.dwellir.com',
      runtime: { 'paseo-network/runtimes': 'asset-hub-paseo_runtime.compressed.wasm' },
    },
    people: {
      node: 'polkadot-omni-node',
      ws: 'wss://people-paseo.rotko.net',
      runtime: { 'paseo-network/runtimes': 'people-paseo_runtime.compressed.wasm' },
    },
    bulletin: {
      node: 'polkadot-omni-node',
      ws: 'wss://bulletin-paseo.tservices.es:8443',
      runtime: {
        'paritytech/polkadot-bulletin-chain': 'bulletin_paseo_runtime.compact.compressed.wasm',
      },
    },
  },
};

/**
 * Per network: how the gate obtains its fork and how long spawn can take.
 * `freshBite: true` means no published bundle exists yet — the gate bites the live
 * network at run time (slower; the engine publishes only previewnet's bundle today).
 * `waitSeconds` is the finality budget after spawn: on forks of the PUBLIC Paseo
 * relay (1-hour epochs) the bite's injected session keys are QUEUED at the first
 * epoch boundary and become the active parachain core assignments only at the
 * second — collators author immediately, but parachains finalize nothing for up to
 * ~2 hours (observed live: one boundary alone did not assign cores). Previewnet
 * runs 1-minute epochs, so the same pipeline completes in minutes.
 */
export const NETWORK_META = {
  // freshBite until PPN publishes a bundle bitten WITH the transaction-storage wipe:
  // production bulletin runs v0.0.24 (active proof schedule), and a bundle bitten
  // without the wipe wedges its bulletin one block after spawn ("Storage proof must
  // be checked once in the block") — flip back to false when a post-fix bundle is up.
  previewnet: { freshBite: true, waitSeconds: 900, gateable: true },
  // Shared-relay forks work since the engine's core-staffing fix (the bite replans
  // ParaScheduler onto cores its 6 validators actually staff) plus the sudo
  // endowment inject — full local E2E green 2026-08-19: bite → spawn (finalizing
  // immediately, no epoch wait) → converge (relay same-spec cycle paid by the
  // endowed sudo) → suite.
  'paseo-next-v2': { freshBite: true, waitSeconds: 900, gateable: true },
  // Same engine path, but devnet's asset-hub cannot be bitten: only the smol
  // chain-spec is published (stateRootHash genesis), and doppelganger rejects it —
  // "Genesis storage in hash format not supported" (verified 2026-08-19). A full
  // raw Paseo Asset Hub spec has to be sourced or generated first.
  devnet: {
    freshBite: true,
    waitSeconds: 900,
    gateable: false,
    blockedBy: 'engine: devnet asset-hub bite fails on the smol spec — needs a full raw chain-spec',
  },
};

/**
 * The engine's binary slots and which repos may provide each. All three sources
 * publish these under identical asset names (bare = linux x86_64,
 * `-aarch64-apple-darwin` = mac), so the source is a manifest choice; whether a
 * given source can actually drive the network (host functions, features) is what
 * the gate run answers.
 *
 * Delivery is the engine's: each slot pin becomes a `PPN_BINARIES` override
 * (`ppnOverrides()`), applied inside PPN's loader so `fetch`, `start` and
 * `show --json` cannot disagree — the PVF workers travel with the polkadot binary
 * because the engine knows its own file set, not because we list them.
 */
export const NODE_BINARIES = {
  polkadot: {
    repos: ['paritytech/polkadot-sdk', 'paritytech/release-automation'],
  },
  'polkadot-omni-node': {
    repos: ['paritytech/polkadot-sdk', 'paritytech/release-automation'],
  },
};

/**
 * Per network: non-chain services, by delivery kind. `override` names the engine
 * binary the pin repoints via PPN_BINARIES (the engine fetches it). `envTag` names
 * the engine env var that pins the service's release tag (the repo is fixed engine
 * wiring). `recordedOnly` pins are tracked in the manifest but not deliverable yet.
 */
export const SERVICES = {
  previewnet: {
    'eth-rpc': {
      override: 'eth-rpc',
      repos: ['paritytech/polkadot-sdk', 'paritytech/release-automation'],
    },
    // The identity service quadruple (identity-api, chain-writer, registration-queue,
    // username-indexer) ships on device-uniqueness-backend's own releases since its
    // v0.2.0; the engine fetches them and DUB_TAG pins the tag. The canonical manifest
    // deliberately does NOT pin this service: the engine's own default tag
    // (config/versions.env in previewnet-engine) governs the baseline, so it can't go
    // stale here. A candidate override may still name it — that exports DUB_TAG for
    // gating a new dub release.
    'identity-backend': {
      envTag: 'DUB_TAG',
      repos: ['paritytech/device-uniqueness-backend'],
    },
    'storage-provider-node': { recordedOnly: true, repos: ['paritytech/web3-storage'] },
    kubo: { recordedOnly: true, repos: ['ipfs/kubo'] },
  },
  // pnv2/devnet forks run only eth-rpc beside the chains — no identity backend, no
  // storage stack (their engine descriptors declare exactly that). The workflow
  // derives FORK_IDENTITY_BACKEND=none from the absence of the service here.
  'paseo-next-v2': {
    'eth-rpc': {
      override: 'eth-rpc',
      repos: ['paritytech/polkadot-sdk', 'paritytech/release-automation'],
    },
  },
  devnet: {
    'eth-rpc': {
      override: 'eth-rpc',
      repos: ['paritytech/polkadot-sdk', 'paritytech/release-automation'],
    },
  },
};

/**
 * Human-readable allow-lists for one network — what the issue template and the
 * issue-ops rejection comment show a tester. Rendered from the same tables the
 * validators enforce, so it cannot drift from what actually passes validation.
 */
export function allowedSources(network) {
  const chains = CHAINS[network];
  if (!chains) throw new Error(`unknown network "${network}"`);
  const lines = [];
  for (const slot of networkSlots(network)) {
    const runners = Object.entries(chains)
      .filter(([, e]) => e.node === slot)
      .map(([c]) => c);
    lines.push(
      `- binary ${slot} (runs ${runners.join(', ')}) from ${NODE_BINARIES[slot].repos.join(' or ')}`
    );
  }
  for (const [chain, entry] of Object.entries(chains)) {
    lines.push(`- ${chain}: runtime from ${Object.keys(entry.runtime).join(' or ')}`);
  }
  for (const [name, svc] of Object.entries(SERVICES[network] ?? {})) {
    const note = svc.recordedOnly ? ' (pin recorded, not yet swapped)' : '';
    lines.push(`- ${name}: from ${svc.repos.join(' or ')}${note}`);
  }
  return lines.join('\n');
}

/** The binary slots a network's chains actually exec, in map order. */
export function networkSlots(network) {
  const chains = CHAINS[network];
  if (!chains) throw new Error(`unknown network "${network}"`);
  return [...new Set(Object.values(chains).map((e) => e.node))];
}

/** The release-asset suffix for this platform; bare names are linux x86_64. */
export function platformAssetSuffix(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return '';
  if (platform === 'darwin' && arch === 'arm64') return '-aarch64-apple-darwin';
  throw new Error(`no release assets exist for ${platform}/${arch}`);
}

/**
 * Parse a runtime or binary pin. Three forms:
 *
 *   owner/repo@tag        a published release. The tag may be "latest".
 *   artifact:<name>       a build uploaded in the calling run, under that
 *                         artifact name. Which file inside it is this chain's
 *                         runtime is decided by what each blob declares, not by
 *                         its filename. `artifact:<name>/<path>` names the file
 *                         outright when a caller ships two for one chain.
 *   file:<path>           a wasm already on disk — what artifact: resolves to
 *                         once downloaded.
 *
 * The last two are legal only in a temporary overlay; see assertNoLocalPins.
 */
export function parseReleaseRef(ref) {
  const raw = String(ref).trim();
  if (raw.startsWith('file:')) {
    const file = raw.slice('file:'.length);
    if (!file) throw new Error(`invalid pin "${ref}" — file: needs a path`);
    return { local: true, file };
  }
  if (raw.startsWith('artifact:')) {
    const rest = raw.slice('artifact:'.length);
    if (!rest) throw new Error(`invalid pin "${ref}" — artifact: needs an artifact name`);
    const slash = rest.indexOf('/');
    return slash === -1
      ? { artifact: rest }
      : { artifact: rest.slice(0, slash), within: rest.slice(slash + 1) };
  }
  const m = /^([\w.-]+\/[\w.-]+)@(\S+)$/.exec(raw);
  if (!m) {
    throw new Error(
      `invalid release ref "${ref}" — expected owner/repo@tag, artifact:<name> or file:<path>`
    );
  }
  return { repo: m[1], tag: m[2] };
}

/** Pin prefixes that name something only this run can see. */
export const EPHEMERAL_PREFIXES = ['file:', 'artifact:'];

const isEphemeral = (pin) => EPHEMERAL_PREFIXES.some((p) => String(pin ?? '').startsWith(p));

/**
 * Refuse `file:` pins in a manifest we commit.
 *
 * Two things need to know WHICH RELEASE a runtime came from, and a path tells
 * them nothing:
 *
 *   - the baseline scan downloads the pinned release every few hours and
 *     byte-compares it against what the chain is actually running. That is how
 *     we know a manifest is still true. A path points at a file on a CI runner
 *     that was deleted minutes later, so there is nothing to download and the
 *     scan cannot check anything.
 *   - the gate refuses a pin older than what production runs, so nobody tests a
 *     rollback by accident. It compares release tags. A path has no tag.
 *
 * So an ephemeral pin is fine for "run the tests against these bytes once" and
 * wrong for "record this as what we deployed". `artifact:` is the same story one
 * step earlier: the artifact expires with the run that uploaded it.
 */
export function assertNoLocalPins(manifest) {
  const bad = [];
  for (const [chain, entry] of Object.entries(manifest.chains ?? {})) {
    if (isEphemeral(entry?.runtime)) bad.push(`chains.${chain}.runtime`);
  }
  for (const [slot, pin] of Object.entries(manifest.binaries ?? {})) {
    if (isEphemeral(pin)) bad.push(`binaries.${slot}`);
  }
  for (const [name, pin] of Object.entries(manifest.services ?? {})) {
    if (isEphemeral(pin)) bad.push(`services.${name}`);
  }
  if (bad.length) {
    throw new Error(
      `a committed manifest may not use file: or artifact: pins (${bad.join(', ')}) — nothing ` +
        `can re-fetch or version-compare one later. Pass a build as a target overlay instead.`
    );
  }
  return manifest;
}

/** Basic manifest shape check — fail fast with a message that names the field. */
export function validateManifest(manifest) {
  const { network } = manifest;
  const known = CHAINS[network];
  if (!known) {
    throw new Error(`unknown network "${network}" — known: ${Object.keys(CHAINS).join(', ')}`);
  }
  if (manifest.base !== 'fork') {
    throw new Error(`base "${manifest.base}" is not supported yet — only "fork"`);
  }
  if (!manifest.chains || Object.keys(manifest.chains).length === 0) {
    throw new Error('manifest.chains must name at least one chain');
  }
  for (const [chain, entry] of Object.entries(manifest.chains)) {
    if (!known[chain]) {
      throw new Error(
        `manifest names unknown chain "${chain}" for ${network} — known: ${Object.keys(known).join(', ')}`
      );
    }
    if (entry?.binary) {
      throw new Error(
        `manifest.chains.${chain} pins a "binary" — binaries are pinned once per engine ` +
          `binary slot under top-level "binaries" (${chain} execs ${known[chain].node})`
      );
    }
    if (!entry?.runtime) {
      throw new Error(`manifest.chains.${chain} must pin a "runtime"`);
    }
  }
  const slots = new Set(Object.entries(manifest.chains).map(([c]) => known[c].node));
  for (const slot of Object.keys(manifest.binaries ?? {})) {
    if (!slots.has(slot)) {
      throw new Error(
        `manifest.binaries pins unknown slot "${slot}" — ${network}'s chains exec: ${[...slots].join(', ')}`
      );
    }
  }
  for (const slot of slots) {
    if (!manifest.binaries?.[slot]) {
      throw new Error(`manifest.binaries must pin "${slot}" — the manifest's chains exec it`);
    }
  }
  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
    throw new Error('manifest.tests must be a non-empty array of chain-tests scripts');
  }
  // A manifest promising a mix no spawn can honor — split pins on a shared binary
  // slot, or a repo outside an allow-list — must fail here, at ask time: the
  // issue/dispatch flow validates before any runner spins up, and only the gate job
  // itself would otherwise reach binaryPlan/runtimePlan.
  runtimePlan(manifest);
  binaryPlan(manifest, '');
  return manifest;
}

/**
 * The runtime-convergence plan: which chain gets which release asset. Every chain must
 * pin one of the repos the map allows for it (the asset name is looked up per repo);
 * chains absent from the manifest are simply not converged (left as the fork has them).
 */
export function runtimePlan(manifest) {
  const known = CHAINS[manifest.network];
  const plan = [];
  for (const [chain, entry] of Object.entries(manifest.chains)) {
    const sources = known[chain].runtime;
    const ref = parseReleaseRef(entry.runtime);
    if (ref.local) {
      // Already a file. Nothing to look up: the converge step only ever wanted a path.
      plan.push({ chain, local: true, file: ref.file });
      continue;
    }
    if (ref.artifact) {
      // Not yet bytes: the gate downloads the artifact and rewrites this to file:
      // before anything needs a path. Validating the source repo is meaningless
      // here — a build in the calling run came from no release.
      plan.push({ chain, artifact: ref.artifact, within: ref.within });
      continue;
    }
    const { repo, tag } = ref;
    const asset = sources[repo];
    if (!asset) {
      throw new Error(
        `${manifest.network}/${chain} runtime must come from ${Object.keys(sources).join(' or ')}, manifest says ${repo}`
      );
    }
    plan.push({ chain, repo, tag, asset });
  }
  return plan;
}

/**
 * The binary-delivery plan. Slot and `override` service pins are validated here but
 * delivered by the engine (see ppnOverrides); `plan` carries only the release files
 * WE download — services delivered by replacing the engine's copies post-fetch.
 * `recorded` lists service pins the gate cannot deliver at all yet.
 */
export function binaryPlan(manifest, suffix = platformAssetSuffix()) {
  const services = SERVICES[manifest.network];
  const plan = [];
  const recorded = [];

  for (const [slot, ref0] of Object.entries(manifest.binaries ?? {})) {
    const source = NODE_BINARIES[slot];
    if (!source) {
      throw new Error(
        `manifest.binaries names unknown slot "${slot}" — known: ${Object.keys(NODE_BINARIES).join(', ')}`
      );
    }
    const ref = parseReleaseRef(ref0);
    if (!source.repos.includes(ref.repo)) {
      throw new Error(
        `${manifest.network}: ${slot} may come from ${source.repos.join(' or ')}, manifest says ${ref.repo}`
      );
    }
  }

  for (const [name, ref0] of Object.entries(manifest.services ?? {})) {
    const source = services[name];
    if (!source) {
      throw new Error(
        `manifest names unknown service "${name}" for ${manifest.network} — known: ${Object.keys(services).join(', ')}`
      );
    }
    const { repo, tag } = parseReleaseRef(ref0);
    if (!source.repos.includes(repo)) {
      throw new Error(
        `${manifest.network}/${name} may come from ${source.repos.join(' or ')}, manifest says ${repo}`
      );
    }
    if (source.recordedOnly) {
      recorded.push(name);
      continue;
    }
    // override/envTag services are engine-delivered via ppnOverrides; nothing here
    // downloads anything anymore, but the loop stays as allow-list validation.
  }
  return { plan, recorded };
}

/**
 * The manifest's engine-delivered pins as a PPN_BINARIES value: every binary slot,
 * plus every service whose delivery is an engine override. Applied inside PPN's
 * loader, so `fetch`, `start` and `show --json` all see the same sources and a
 * typoed name is refused by the engine rather than silently ignored.
 */
export function ppnOverrides(manifest) {
  binaryPlan(manifest, ''); // reject bad slots/repos before emitting anything
  const entries = Object.entries(manifest.binaries ?? {}).map(([slot, ref]) => `${slot}=${ref}`);
  const services = SERVICES[manifest.network] ?? {};
  for (const [name, ref] of Object.entries(manifest.services ?? {})) {
    if (services[name]?.override) entries.push(`${services[name].override}=${ref}`);
  }
  return entries.join(','); // PPN_BINARIES entries are comma-separated (overridesFromEnv)
}

/**
 * The manifest's env-tag pins: services whose release tag the engine takes from an
 * environment variable (the repo is engine wiring) — e.g. identity-backend's
 * DUB_TAG. Returned as { VAR: tag } for the workflow's $GITHUB_ENV.
 */
export function envTagPins(manifest) {
  const services = SERVICES[manifest.network] ?? {};
  const out = {};
  for (const [name, ref] of Object.entries(manifest.services ?? {})) {
    const svc = services[name];
    if (svc?.envTag) out[svc.envTag] = parseReleaseRef(ref).tag;
  }
  return out;
}

/**
 * Overlay a sparse target (the ask, Y) onto the canonical manifest (deployed state, X).
 * The target may only narrow: binary slots, chains and services it names must exist
 * in the canonical; chain entries patch `runtime`, `binaries` entries patch a slot's
 * source. A target naming something unknown is a typo, not a request.
 */
export function mergeTarget(canonical, target) {
  if (!target) return canonical;
  const binaries = { ...(canonical.binaries ?? {}) };
  for (const [slot, ref] of Object.entries(target.binaries ?? {})) {
    if (!(slot in binaries)) {
      throw new Error(`target names binary slot "${slot}" absent from the canonical manifest`);
    }
    binaries[slot] = ref;
  }
  const chains = { ...canonical.chains };
  for (const [chain, patch] of Object.entries(target.chains ?? {})) {
    if (!chains[chain]) {
      throw new Error(`target names chain "${chain}" absent from the canonical manifest`);
    }
    if (patch?.binary) {
      throw new Error(
        `target patches chains.${chain}.binary — binaries are pinned per slot: use "binaries" (e.g. {"binaries":{"polkadot-omni-node":"owner/repo@tag"}})`
      );
    }
    chains[chain] = { ...chains[chain], ...patch };
  }
  const services = { ...(canonical.services ?? {}) };
  for (const [name, ref] of Object.entries(target.services ?? {})) {
    // A service the canonical doesn't pin is still overridable if the network
    // declares it (SERVICES) — e.g. identity-backend, whose baseline tag is the
    // engine's own default and only a candidate override exports DUB_TAG.
    if (!(name in services) && !SERVICES[canonical.network]?.[name]) {
      throw new Error(`target names service "${name}" unknown to ${canonical.network}`);
    }
    services[name] = ref;
  }
  const merged = { ...canonical, binaries, chains, services };
  if (target.tests) merged.tests = target.tests;
  return merged;
}

/**
 * The tested transitions, human-readable: which pins a manifest moves relative to the
 * canonical. This is what the run summary reports — "what X → Y did this run prove".
 */
export function transitions(canonical, manifest) {
  const out = [];
  for (const [slot, ref] of Object.entries(manifest.binaries ?? {})) {
    const from = (canonical.binaries ?? {})[slot];
    if (from && from !== ref) out.push(`${slot}: binary ${from} → ${ref}`);
  }
  for (const [chain, entry] of Object.entries(manifest.chains ?? {})) {
    const from = canonical.chains?.[chain];
    if (!from) continue;
    if (from.runtime !== entry.runtime) out.push(`${chain}: runtime ${from.runtime} → ${entry.runtime}`);
  }
  for (const [name, ref] of Object.entries(manifest.services ?? {})) {
    const from = (canonical.services ?? {})[name];
    if (from && from !== ref) out.push(`${name}: ${from} → ${ref}`);
    if (!from) out.push(`${name}: (engine default) → ${ref}`);
  }
  return out.length ? out : ['steady state — no pin moves; the run asserts canonical matches production'];
}

/**
 * The candidate matrix for a gate run: which configurations to test, each as a
 * complete synthesized manifest.
 *
 * A PR moving both the binary and the runtime dimension decomposes into the target
 * state plus two informational cross terms — new binaries × current runtimes ("can
 * the fleet upgrade binaries first?") and current binaries × new runtimes ("does the
 * upgrade enact without the binary bump?"). Cross-term failures are rollout-ordering
 * findings, not defects of the target. Single-dimension PRs collapse to the target;
 * so do PRs that change the chain set itself (cross terms are ill-defined then).
 */
export function candidateMatrix(base, head) {
  const chainNames = (m) => Object.keys(m.chains ?? {}).sort().join(',');
  const binaryDim = (m) => JSON.stringify({ b: m.binaries ?? {}, s: m.services ?? {} });
  const runtimeDim = (m) =>
    JSON.stringify(Object.fromEntries(Object.entries(m.chains ?? {}).map(([k, v]) => [k, v.runtime])));

  const finish = (arr) => arr.map((c) => ({ ...c, transitions: transitions(base ?? head, c.manifest) }));
  const target = {
    id: 'target',
    gating: true,
    purpose: 'the declared target state — new binaries and new runtimes together, rollout order',
    manifest: head,
  };
  if (
    !base ||
    chainNames(base) !== chainNames(head) ||
    (binaryDim(base) === binaryDim(head) && runtimeDim(base) === runtimeDim(head))
  ) {
    return finish([target]);
  }

  const candidates = [target];
  const cross = [
    {
      id: 'binaries-only',
      purpose: 'new binaries under the CURRENT runtimes — can the fleet upgrade binaries first?',
      manifest: { ...head, chains: base.chains },
    },
    {
      id: 'runtimes-only',
      purpose: 'new runtimes on the CURRENT binaries — does the upgrade enact without the binary bump?',
      manifest: { ...head, binaries: base.binaries, services: base.services },
    },
  ];
  const pins = (m) => binaryDim(m) + runtimeDim(m);
  for (const c of cross) {
    if (pins(c.manifest) !== pins(head) && pins(c.manifest) !== pins(base)) {
      candidates.push({ ...c, gating: false });
    }
  }
  return finish(candidates);
}
