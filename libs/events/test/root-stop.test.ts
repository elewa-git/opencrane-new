import { expect, it } from 'vitest';
import { budgetRootStoppedDataSchema } from '../src/index.ts';

const reasons = ['requester_stop', 'turn_ended', 'access_revoked'] as const;
function acceptsSource(reason: typeof reasons[number]) {
  const stop = { rootId: 'root', reason, sourceSubject: 'conversation-chat',
    sourcePosition: 3, sourceEventId: 'event' };
  expect(budgetRootStoppedDataSchema.safeParse(stop).success).toBe(true);
  for (const field of ['rootId', 'sourceSubject', 'sourceEventId'] as const) {
    expect(budgetRootStoppedDataSchema.safeParse({ ...stop, [field]: '' }).success).toBe(false);
  }
  for (const sourcePosition of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(budgetRootStoppedDataSchema.safeParse({ ...stop, sourcePosition }).success).toBe(false);
  }
  for (const field of ['sourceSubject', 'sourcePosition', 'sourceEventId'] as const) {
    const missing: Record<string, unknown> = { ...stop };
    delete missing[field];
    expect(budgetRootStoppedDataSchema.safeParse(missing).success).toBe(false);
  }
  const mixed = { ...stop, stopId: 'ceiling-stop' };
  expect(budgetRootStoppedDataSchema.safeParse(mixed).success).toBe(false);
}
it.each(reasons)('requires the exact source reference for %s', acceptsSource);
