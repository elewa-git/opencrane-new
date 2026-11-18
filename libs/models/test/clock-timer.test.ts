import { expect, it, vi } from 'vitest';
import { manualClock } from '@opencrane/event-store/testing';
import { clockTimer } from '../src/clock-timer.ts';

it('cancels a resolved sleep before its callback gets CPU time', async () => {
  const clock = manualClock();
  const elapsed = vi.fn();
  const cancel = clockTimer({ clock, milliseconds: 2000, elapsed });
  clock.advance(2000);
  cancel();
  await Promise.resolve();
  expect(elapsed).not.toHaveBeenCalled();
});

it('runs a deadline callback once at the original boundary', async () => {
  const clock = manualClock(1_000_000);
  const elapsed = vi.fn();
  const cancel = clockTimer({ clock, milliseconds: 2000, elapsed });
  clock.advance(1999);
  await Promise.resolve();
  expect(elapsed).not.toHaveBeenCalled();
  clock.advance(1);
  await Promise.resolve();
  expect(elapsed).toHaveBeenCalledTimes(1);
  clock.advance(2000);
  await Promise.resolve();
  expect(elapsed).toHaveBeenCalledTimes(1);
  cancel();
});
