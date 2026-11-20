export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

/** `seconds` of chain time as UTC, to the second. */
export const iso = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;

/**
 * `promise`, or a rejection that contains `what` after `ms`, with `onTimeout` called first: one
 * reply that never comes must not hang a caller.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what}: no answer in ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What `read` resolves to, after up to `attempts` calls `pauseMs` apart; its last error after that. */
export async function retry<T>(attempts: number, pauseMs: number, read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`${(error as Error).message}; attempt ${attempt} of ${attempts}`);
      await sleep(pauseMs);
    }
  }
}

/**
 * What `read` resolves to, read again while it fails, 1 s after the first failure and twice as
 * long after each next one up to 30 s, until `waitMs` from the first read have passed; then its
 * last error, with how many reads it took. `onRetry` hears each failure before the pause.
 */
export async function retryUntil<T>(read: () => Promise<T>, waitMs: number, onRetry: (error: Error, attempt: number, pauseMs: number) => void): Promise<T> {
  const until = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() >= until) throw new Error(`${(error as Error).message}, ${attempt} reads over ${waitMs / 1000} s`);
      const pauseMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      onRetry(error as Error, attempt, pauseMs);
      await sleep(pauseMs);
    }
  }
}

/** `read` over every item, at most `concurrency` at once, the results in item order. */
export async function readAll<T, R>(items: T[], read: (item: T) => Promise<R>, concurrency = 100): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const position = next++;
        results[position] = await read(items[position]);
      }
    }),
  );
  return results;
}
