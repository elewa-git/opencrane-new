import { setTimeout as delay } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import { readComputerControl } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';

export function takeoverClock(requestedAt: string) {
  const wallStart = Date.parse(requestedAt);
  const monotonicStart = performance.now();
  const wall = vi.spyOn(Date, 'now').mockReturnValue(wallStart);
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(monotonicStart);
  function advance(elapsed: number, wallElapsed = elapsed) {
    wall.mockReturnValue(wallStart + wallElapsed);
    monotonic.mockReturnValue(monotonicStart + elapsed);
  }
  return { advance };
}

export async function waitForControl(store: EventStore, phase: string) {
  let control;
  for (let attempt = 0; attempt < 200; attempt++) {
    control = await readComputerControl(store, 'test', 'assistant');
    if (control?.phase === phase) return control;
    await delay(10);
  }
  expect(control?.phase).toBe(phase);
  throw new Error('Control did not reach the expected phase');
}

export function trackPauseObservations() {
  const writes = vi.spyOn(Map.prototype, 'set');
  function retained() {
    for (let index = 0; index < writes.mock.calls.length; index++) {
      const key: unknown = writes.mock.calls[index]?.[0];
      if (typeof key === 'string' && key.startsWith('["test","assistant"')) {
        return writes.mock.contexts[index];
      }
    }
    return undefined;
  }
  return retained;
}
