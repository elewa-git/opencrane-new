import { vi } from 'vitest';
import type { createRoutineSender } from '../../src/routine-sender.ts';

type Sender = ReturnType<typeof createRoutineSender>;

export async function sendWithFixtureTime(makeSender: () => Sender,
  wake: Parameters<Sender['send']>[0]) {
  // Hold send setup time so scheduling cannot prevent the intended saved-event checks.
  const fixtureTime = performance.now();
  function fixedFixtureTime() {
    return fixtureTime;
  }
  const monotonicClock = vi.spyOn(performance, 'now');
  monotonicClock.mockImplementation(fixedFixtureTime);
  try {
    const authority = makeSender();
    return await authority.send(wake);
  } finally {
    monotonicClock.mockRestore();
  }
}

export function advanceRoutineFixtureClock(milliseconds: number) {
  const monotonic = performance.now.bind(performance);
  function afterWake() {
    return monotonic() + milliseconds;
  }
  vi.spyOn(performance, 'now').mockImplementation(afterWake);
}
