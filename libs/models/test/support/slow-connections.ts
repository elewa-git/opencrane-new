import { expect, vi } from 'vitest';
import type { databases } from '@opencrane/authz/testing';

type ConnectionQueue = Awaited<ReturnType<typeof databases>>['queue'];

export async function withSlowConnections(
  queue: ConnectionQueue, work: () => Promise<void>, count = 2,
) {
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  let slowConnections = 0;
  function now() {
    return realNow() + elapsed;
  }
  function acquired() {
    if (slowConnections < count) {
      // Model connections arriving after the production acquisition deadline.
      // Advance the clock instead of sleeping or depending on machine load.
      elapsed += 101;
      slowConnections += 1;
    }
  }
  const clock = vi.spyOn(performance, 'now');
  clock.mockImplementation(now);
  queue.on('acquire', acquired);
  try {
    await work();
    expect(slowConnections).toBe(count);
  } finally {
    queue.off('acquire', acquired);
    clock.mockRestore();
  }
}
