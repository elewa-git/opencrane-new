/** Runs `total` units of work through `concurrency` workers pulling from a
 * shared counter — a simple, dependency-free replacement for a promise
 * pool library, used to pipeline JetStream publishes at scale. */
export async function runPool(
  total: number,
  concurrency: number,
  worker: (i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let firstError: unknown;
  async function runner() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      try {
        await worker(i);
      } catch (err) {
        firstError ??= err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runner));
  if (firstError) throw firstError;
}
