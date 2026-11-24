export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

/** `promise`, or a rejection that contains `what` after `ms`: one reply that never comes must not hang a caller. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
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
