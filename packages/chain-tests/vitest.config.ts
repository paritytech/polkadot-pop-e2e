import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup.ts"],
    globalSetup: ["src/tests/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: ["default", "junit", "./src/tests/reporter.ts"],
    outputFile: { junit: "./test-results/junit.xml" },
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    bail: 0,
  },
});
