import { setTimeout } from 'node:timers/promises';

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

function now(): number {
  return performance.now();
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const options = signal ? { signal } : undefined;
  await setTimeout(milliseconds, undefined, options);
}

export const systemClock: Clock = { now, sleep };
