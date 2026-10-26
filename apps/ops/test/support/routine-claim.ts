import { expect } from 'vitest';
import { claimRoutineDue } from '../../src/routine-due.ts';

/** Save a real scheduled claim for tests which continue with session preparation. */
export async function claimScheduledRoutine(...args: Parameters<typeof claimRoutineDue>) {
  const result = await claimRoutineDue(...args);
  expect(result.status).toBe('confirmed');
  expect(result.executionAvailable).toBe(false);
  return result;
}
