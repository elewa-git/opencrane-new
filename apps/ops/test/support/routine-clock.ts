import { vi } from 'vitest';

export function holdFixtureClock() {
  const fixedTime = performance.now();
  function fixedClock() {
    return fixedTime;
  }
  vi.spyOn(performance, 'now').mockImplementation(fixedClock);
}

export async function withRoutineFixtureClock<Result>(work: () => Promise<Result>) {
  if (!vi.isMockFunction(performance.now)) holdFixtureClock();
  return work();
}
