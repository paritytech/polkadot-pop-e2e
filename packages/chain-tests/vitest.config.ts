import { defineConfig } from "vitest/config";

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
    bail: 0,
  },
});
