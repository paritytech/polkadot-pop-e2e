export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

/** `promise`, or a rejection naming `what` after `ms`: one reply that never comes must not hang a caller. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What `read` resolves to, trying it up to `attempts` times `pauseMs` apart; its last error after that. */
export async function retry<T>(attempts: number, pauseMs: number, read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(pauseMs);
    }
  }
}
