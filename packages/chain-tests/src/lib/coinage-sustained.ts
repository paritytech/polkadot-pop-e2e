/** Feedback-controlled submission. Pool pressure and successful receipts are separate results. */
export type PoolTransition = 'ready' | 'in-block' | 'retracted' | 'terminal';
export type Supply<T> = { kind: 'work'; work: T } | { kind: 'wait' } | { kind: 'exhausted' };
export interface PoolSample {
  elapsedMs: number;
  phase: 'fill' | 'hold';
  ready: number;
  locallyQueued: number;
  outstanding: number;
  submitted: number;
}

export async function sustainPool<T, R>(options: {
  readReady: () => Promise<number>;
  next: () => Promise<Supply<T>>;
  submit: (work: T, transition: (value: PoolTransition) => void) => Promise<R>;
  recordSample: (sample: PoolSample) => void;
  recordResult: (work: T, result: R) => void;
  target?: number;
  poolLimit?: number;
  durationMs?: number;
  fillTimeoutMs?: number;
  pollMs?: number;
  batchSize?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const target = options.target ?? 8000, limit = options.poolLimit ?? 8192;
  const duration = options.durationMs ?? 180000, fillTimeout = options.fillTimeoutMs ?? 120000;
  const pollMs = options.pollMs ?? 100, batchSize = options.batchSize ?? 256;
  if (!(target > 0 && target < limit && duration > 0 && pollMs > 0 && batchSize > 0)) {
    throw new Error('Invalid sustained-pool configuration');
  }
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const start = now(), lower = Math.floor(target * .95);
  const queued = new Set<number>();
  const pending = new Map<number, Promise<void>>();
  let submitted = 0, settled = 0, holdStart: number | undefined;
  let reason = 'hold-complete', error: string | undefined;
  let peak = 0, minimum: number | undefined, sampledInBandMs = 0, sampledMs = 0;
  let previous: { time: number; ready: number } | undefined;
  const asyncErrors: string[] = [];
  try {
    while (true) {
      const ready = await options.readReady();
      const time = now();
      if (!Number.isInteger(ready) || ready < 0) throw new Error('Ready-pool gauge missing or invalid');
      if (holdStart === undefined && ready >= lower) holdStart = time;
      if (holdStart !== undefined) {
        peak = Math.max(peak, ready); minimum = Math.min(minimum ?? ready, ready);
        if (previous && time - previous.time <= Math.max(1000, 3 * pollMs)) {
          const interval = Math.max(0, Math.min(time, holdStart + duration) - Math.max(previous.time, holdStart));
          sampledMs += interval;
          if (previous.ready >= lower && previous.ready <= limit) sampledInBandMs += interval;
        }
      }
      previous = { time, ready };
      options.recordSample({ elapsedMs: time - start, phase: holdStart === undefined ? 'fill' : 'hold',
        ready, locallyQueued: queued.size, outstanding: pending.size, submitted });
      if (holdStart !== undefined && time >= holdStart + duration) break;
      if (holdStart === undefined && time - start >= fillTimeout) { reason = 'fill-timeout'; break; }
      if (asyncErrors.length) { reason = 'submit-or-evidence-error'; break; }
      // Unknown/ready local submissions remain reserved until inclusion or a terminal outcome.
      // A low or lagging gauge alone must never cause a second full batch of 8,000.
      const budget = Math.min(batchSize, Math.max(0, target - Math.max(ready, queued.size)),
        Math.max(0, target * 2 - pending.size));
      for (let n = 0; n < budget; n++) {
        if (holdStart !== undefined && now() >= holdStart + duration) break;
        const supplied = await options.next();
        if (supplied.kind === 'exhausted') { reason = 'inventory-exhausted'; break; }
        if (supplied.kind === 'wait') break;
        if (holdStart !== undefined && now() >= holdStart + duration) break;
        const id = submitted++;
        queued.add(id);
        const transition = (value: PoolTransition) => {
          if (value === 'ready' || value === 'retracted') queued.add(id);
          else queued.delete(id);
        };
        // Keep rejections handled while the hold loop continues; no automatic retry.
        const task = Promise.resolve().then(() => options.submit(supplied.work, transition))
          .then(result => options.recordResult(supplied.work, result))
          .catch(cause => { asyncErrors.push(String(cause)); })
          .finally(() => { settled++; queued.delete(id); pending.delete(id); });
        pending.set(id, task);
      }
      if (reason !== 'hold-complete') break;
      await sleep(pollMs);
    }
  } catch (cause) { reason = 'controller-error'; error = String(cause); }
  const stopped = now();
  // submit() must impose its own finality timeout. Audit terminal outcomes after draining.
  await Promise.all(pending.values());
  return {
    target, poolLimit: limit, band: [lower, limit], requestedHoldMs: duration,
    fillMs: (holdStart ?? stopped) - start,
    observedHoldMs: holdStart === undefined ? 0 : Math.min(duration, stopped - holdStart),
    holdCompleted: holdStart !== undefined && stopped >= holdStart + duration,
    sampledMs, sampledInBandMs, fractionOfRequestedHoldInBand: sampledInBandMs / duration,
    unobservedHoldMs: Math.max(0, duration - sampledMs),
    minimumReady: minimum ?? null, peakReady: peak, submitted, settled,
    drainMs: now() - stopped, reason, error, asyncErrors,
    measurement: 'Ingress ready gauge; interval estimates from samples, not exact continuous occupancy',
  };
}
