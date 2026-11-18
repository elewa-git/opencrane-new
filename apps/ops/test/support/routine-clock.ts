import { vi } from 'vitest';
import { manualClock } from '@opencrane/event-store/testing';

export function holdFixtureClock(elapsed = 0) {
  const clock = manualClock(performance.now());
  clock.advance(elapsed);
  const now = clock.now.bind(clock);
  return vi.spyOn(performance, 'now').mockImplementation(now);
}

export async function withRoutineFixtureClock<Result>(work: () => Promise<Result>) {
  // Hold fixture time while real services reply; advance it to test an expired deadline.
  const options: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['setTimeout', 'clearTimeout', 'performance'],
    shouldClearNativeTimers: true,
  };
  vi.useFakeTimers(options);
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}
