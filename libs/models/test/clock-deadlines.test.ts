import { expect, it, vi } from 'vitest';
import type { EventStore } from '@opencrane/event-store';
import { manualClock } from '@opencrane/event-store/testing';
import { appendCheckedState } from '../src/append-checked-state.ts';
import { envelope } from '../src/budget-migration.ts';

async function retryBoundary(elapsed: number) {
  const clock = manualClock();
  const append = vi.fn<EventStore['append']>();
  append.mockResolvedValue({ status: 'conflict' });
  const head = vi.fn<EventStore['head']>();
  head.mockResolvedValue(1);
  const store = { clock, append, head } satisfies Pick<EventStore, 'clock' | 'append' | 'head'>;
  let checks = 0;
  function unchanged() {
    checks++;
    if (checks === 1) {
      clock.advance(elapsed);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  const event = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
  });
  const command = { event, expectedSequence: 0, expectedGlobalSequence: 0, deadline: 2000 };
  const result = await appendCheckedState(store, command, unchanged);
  expect(checks).toBe(elapsed < 2000 ? 2 : 1);
  expect(result.status).toBe(elapsed < 2000 ? 'conflict' : 'unavailable');
}
it.each([1999, 2000])('uses the store clock at the retry boundary after %i ms', retryBoundary);

async function decisionTimes() {
  const { decisionHistoryDeadline, decisionAccessStarted } = await import('../src/decision-activity.ts');
  const clock = manualClock(1_000_000);
  const options = { clock };
  expect(decisionHistoryDeadline(true, 2000, false, options)).toBe(1_010_000);
  expect(decisionHistoryDeadline(false, 2000, true, options)).toBe(1_010_000);
  expect(decisionHistoryDeadline(false, 2000, false, options)).toBe(2000);
  expect(decisionAccessStarted(true, false, 0, options)).toBe(1_000_000);
  clock.advance(1999);
  expect(decisionAccessStarted(false, true, 0, options)).toBe(1_001_999);
  expect(decisionAccessStarted(false, false, 0, options)).toBe(0);
}
it('dates managed history and renewed access from the named clock', decisionTimes);

async function spendingDeadlines() {
  const { readSpendingCalls, readSpendingEffects, readCurrentEffects } =
    await import('../src/accounting.ts');
  const clock = manualClock(1_000_000);
  const query = vi.fn();
  query.mockResolvedValue({ rows: [] });
  const db = { query };
  const options = { clock };
  await expect(readSpendingCalls(db, 'test', {}, options)).rejects.toThrow('unavailable');
  await expect(readSpendingEffects(db, 'test', {}, options)).rejects.toThrow('unavailable');
  await expect(readCurrentEffects(db, 'test', 0, {}, options)).rejects.toThrow('unavailable');
  expect(query).toHaveBeenCalledTimes(3);
  for (const call of query.mock.calls) {
    expect(call[2]).toEqual({ deadline: 1_002_000 });
  }
}
it('passes the named clock deadline to every spending reader', spendingDeadlines);
