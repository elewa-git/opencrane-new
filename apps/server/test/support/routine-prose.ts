import { expect } from 'vitest';
import type { StoredEvent } from '@opencrane/event-store';

function isInput(row: StoredEvent) {
  return row.event.type === 'message.posted';
}

export function expectRoutineInput(rows: StoredEvent[]) {
  const inputs = rows.filter(isInput);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.event.data).toMatchObject({
    utterance: 'Routine instructions (user data):\n\nPrivate routine instructions',
  });
}

export function expectRoutineStreamProse(rows: StoredEvent[], subject: string,
  conversationSubject: string) {
  if (subject === conversationSubject) {
    expectRoutineInput(rows);
  }
  if (subject === 'budget-test') {
    expect(JSON.stringify(rows)).not.toContain('Private routine instructions');
  }
}
