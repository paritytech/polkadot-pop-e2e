import type { Reporter, TestModule } from "vitest/node";

/**
 * Custom reporter that prints a clear summary table at the end of the test run.
 */
export default class HealthReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    if (!testModules.length) return;

    const network = process.env.NETWORK ?? "unknown";
    const results: {
      suite: string;
      test: string;
      status: string;
      duration: number;
    }[] = [];

    for (const testModule of testModules) {
      const fileSuite = suiteName(testModule.moduleId);
      for (const test of testModule.children.allTests()) {
        const state = test.result().state;
        results.push({
          suite: test.parent.type === "suite" && test.parent.name ? test.parent.name : fileSuite,
          test: test.name,
          status: state === "passed" ? "pass" : state === "failed" ? "fail" : "skip",
          duration: test.diagnostic()?.duration ?? 0,
        });
      }
    }

    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const skipped = results.filter((r) => r.status === "skip").length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    console.log("\n");
    console.log("═".repeat(80));
    console.log(`  NETWORK FUNCTIONAL HEALTH — ${network.toUpperCase()}`);
    console.log("═".repeat(80));
    console.log("");

    // Group by suite
    const suites = new Map<string, typeof results>();
    for (const r of results) {
      const list = suites.get(r.suite) ?? [];
      list.push(r);
      suites.set(r.suite, list);
    }

    for (const [suite, tests] of suites) {
      const suitePass = tests.every((t) => t.status !== "fail");
      const icon = suitePass ? "✓" : "✗";
      console.log(`  ${icon} ${suite}`);

      for (const t of tests) {
        const icon =
          t.status === "pass" ? "  ✓" :
          t.status === "fail" ? "  ✗" :
          "  ○";
        const dur = t.duration > 0 ? ` (${formatDuration(t.duration)})` : "";
        console.log(`    ${icon} ${t.test}${dur}`);
      }
      console.log("");
    }

    console.log("─".repeat(80));
    console.log(
      `  ${passed} passed, ${failed} failed, ${skipped} skipped — ${formatDuration(totalDuration)} total`,
    );

    if (failed > 0) {
      console.log("");
      console.log("  FAILED:");
      for (const r of results.filter((r) => r.status === "fail")) {
        console.log(`    ✗ [${r.suite}] ${r.test}`);
      }
    }

    console.log("═".repeat(80));
    console.log("");
  }
}

function suiteName(moduleId: string): string {
  // core.test.ts -> core
  const match = moduleId.match(/([^/]+)\.test\./);
  return match?.[1] ?? moduleId;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
