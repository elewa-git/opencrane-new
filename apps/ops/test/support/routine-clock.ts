import { vi } from 'vitest';

export function holdFixtureClock() {
  const fixedTime = performance.now();
  function fixedClock() {
    return fixedTime;
  }
  const monotonicClock = vi.spyOn(performance, 'now');
  monotonicClock.mockImplementation(fixedClock);
  return monotonicClock;
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
