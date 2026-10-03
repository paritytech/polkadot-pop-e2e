import { writeFileSync } from 'node:fs';

/** Arm only after the workload finishes. This timer must not keep a clean process alive. */
export function armShutdownDeadline(evidencePath: string, timeoutMs = 120_000) {
  const started = Date.now();
  const timer = setTimeout(() => {
    try {
      writeFileSync(evidencePath, JSON.stringify({
        kind: 'harness-shutdown-timeout', elapsedMs: Date.now() - started,
        priorExitCode: process.exitCode ?? 0,
        activeResources: process.getActiveResourcesInfo(), memory: process.memoryUsage(),
        note: 'Workload finished before this deadline was armed. Receipt and state results remain separate.',
      }, null, 2) + '\n');
    } finally {
      // A shutdown leak is never a successful CI run, even when the workload passed.
      process.exit(1);
    }
  }, timeoutMs);
  timer.unref();
  return timer;
}
