import { expect, it, vi } from 'vitest';
import type { EventStore } from '@opencrane/event-store';
import { manualClock } from '@opencrane/event-store/testing';
import { appendCheckedState } from '../src/append-checked-state.ts';
import { envelope } from '../src/budget-migration.ts';

it.each([1999, 2000])('uses the store clock at the retry boundary after %i ms', async elapsed => {
  const clock = manualClock();
  const append = vi.fn<EventStore['append']>();
  append.mockResolvedValue({ status: 'conflict' });
  const head = vi.fn<EventStore['head']>();
  head.mockResolvedValue(1);
  const store = { clock, append, head } satisfies Pick<EventStore, 'clock' | 'append' | 'head'>;
  let checks = 0;
  async function unchanged() {
    checks++;
    if (checks === 1) {
      clock.advance(elapsed);
      return true;
    }
    return false;
  }
  const event = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
  });
  const command = { event, expectedSequence: 0, expectedGlobalSequence: 0, deadline: 2000 };
  const result = await appendCheckedState(store, command, unchanged);
  expect(checks).toBe(elapsed < 2000 ? 2 : 1);
  expect(result.status).toBe(elapsed < 2000 ? 'conflict' : 'unavailable');
});
