import { defineConfig } from "vitest/config";
import OrderedSequencer from "./src/tests/test-sequencer.ts";

export default defineConfig({
  test: {
    // Broad include lets vitest discover both the main functional
    // suite and the health probes; npm scripts in package.json pick
    // exactly which files to run so probes and suite stay separate.
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    testTimeout: 120_000,
    // Must exceed `ASSIGNED_TIMEOUT_MS` (100 s in attested-fixture.ts) plus
    // a small headroom for signAndRegister + chain client setup. With a 60 s
    // hook timeout, vitest aborts beforeAll before our nice "IB reconciler
    // lagging" message can throw — the operator sees a generic
    // `Hook timed out` and the actual IB attribution gets lost. 120 s gives
    // us the full 100 s poll budget plus 20 s for register + client setup.
    hookTimeout: 120_000,
    reporters: ["default", "junit", "./src/tests/reporter.ts"],
    outputFile: { junit: "./test-results/junit.xml" },
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // The IB-Health probe seeds an attested account via `ensureAttested()`
    // in attested-fixture.ts; subsequent test files that import the same
    // fixture are supposed to reuse the cached success — OR fast-fail off
    // the cached `[ib-cascade]` rejection when IB is down. With vitest's
    // default `isolate: true`, every test file gets its own VM context
    // and the module's `inflight` / `cachedFailure` state is per-file,
    // not shared. Result: when IB is degraded, every dependent file
    // re-registers a fresh username and burns 100 s polling — observed
    // 4 × 100 s on run 26398574954/previewnet against ONE outage.
    // Setting `isolate: false` shares one VM context across files in the
    // single fork, so module state actually persists. Safe because none
    // of our test files mutate shared module exports — they only read
    // from `getNetworkConfig`, `createPeopleClient`, etc.
    isolate: false,
    // Also pin to sequential file execution. With `singleFork: true` we
    // get one process; without this option vitest can still parallelise
    // files inside that process via tinypool. JUnit timestamps on the
    // 2026-05-25 run show all six files reporting the same suite-start
    // millisecond — they were running concurrently, so the probe and
    // dependent files raced for IB registration instead of the probe
    // running first and seeding the cache.
    fileParallelism: false,
    bail: 0,
    // Vitest's default sequencer prioritises previously-failed files
    // first then sorts by duration descending — great for CI fail-fast,
    // wrong for us because we depend on a strict probe → feature
    // ordering (chain-health → ring-health → ib-health →
    // ring-inclusion → feature suites). The custom sequencer below
    // enforces that order deterministically across runs and ignores
    // failed-first heuristics. See src/tests/test-sequencer.ts.
    sequence: {
      sequencer: OrderedSequencer,
    },
  },
});
