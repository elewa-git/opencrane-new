import { expect, vi } from 'vitest';
import { manualClock, type ManualClock } from '@opencrane/event-store/testing';
import type { createRoutineSender } from '../../src/routine-sender.ts';

type Sender = ReturnType<typeof createRoutineSender>;

export async function sendWithFixtureTime(makeSender: () => Sender,
  wake: Parameters<Sender['send']>[0]) {
  // Hold send setup time so scheduling cannot prevent the intended refusal.
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

export async function checkSlowPayerPublication(
  send: (kind: string, clock: ManualClock) => Promise<void>) {
  const originalNow: unknown = Reflect.get(performance, 'now');
  const startedAt = performance.now();
  // Keep the test clock near real time so other fixture timers do not inherit a future deadline.
  const publicationClock = manualClock(startedAt);
  function publicationTime() {
    return publicationClock.now();
  }
  const monotonicClock = vi.spyOn(performance, 'now');
  monotonicClock.mockImplementation(publicationTime);
  try {
    await send('payer', publicationClock);
    expect(publicationClock.now()).toBe(startedAt + 2100);
    expect(Reflect.get(performance, 'now')).toBe(originalNow);
    expect(performance.now()).not.toBe(publicationClock.now());
  } finally {
    monotonicClock.mockRestore();
  }
}
