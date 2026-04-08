import type { Reporter, File, Task } from "vitest";

/**
 * Custom reporter that prints a clear summary table at the end of the test run.
 */
export default class HealthReporter implements Reporter {
  onFinished(files?: File[]) {
    if (!files?.length) return;

    const network = process.env.NETWORK ?? "unknown";
    const results: {
      suite: string;
      test: string;
      status: string;
      duration: number;
    }[] = [];

    for (const file of files) {
      const suiteName = this.getSuiteName(file);
      this.collectResults(file.tasks, suiteName, results);
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

  private getSuiteName(file: File): string {
    // Extract from filename: core.test.ts -> Core
    const match = file.name.match(/([^/]+)\.test\./);
    return match?.[1] ?? file.name;
  }

  private collectResults(
    tasks: Task[],
    suite: string,
    results: { suite: string; test: string; status: string; duration: number }[],
  ) {
    for (const task of tasks) {
      if (task.type === "suite") {
        const name = task.name || suite;
        this.collectResults(task.tasks, name, results);
      } else if (task.type === "test") {
        results.push({
          suite,
          test: task.name,
          status:
            task.result?.state === "pass" ? "pass" :
            task.result?.state === "fail" ? "fail" :
            "skip",
          duration: task.result?.duration ?? 0,
        });
      }
    }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
