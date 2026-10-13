/** Reject if work does not settle within `ms`, aborting the signal it was handed
 *  so the underlying request stops instead of running on unobserved. Shared by the
 *  scheduler (per-session classify) and the hierarchical classifier (per-chunk classify). */
export class TimeoutError extends Error {}

export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
