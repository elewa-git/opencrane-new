import { expect, it } from 'vitest';
import { chatRowSchema } from '../src/chat.ts';

it('accepts only reviewed command labels in chat rows, including older rows without one', () => {
  const row = { id: 'command', position: 2, type: 'agent.command_ran',
    time: '2026-11-09T10:00:00Z', data: { turnId: 'turn', exitCode: 0 } };
  expect(chatRowSchema.safeParse(row).success).toBe(true);
  expect(chatRowSchema.safeParse({ ...row, data: { ...row.data,
    activityLabel: 'Listed files' } }).success).toBe(true);
  expect(chatRowSchema.safeParse({ ...row, data: { ...row.data,
    activityLabel: 'Read private-report.pdf' } }).success).toBe(false);
});
