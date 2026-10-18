import { expect, it } from 'vitest';
import { approvalCardsSchema } from '../src/index.ts';

const card = {
  approvalId: 'approval', conversationId: 'conversation', requesterId: 'alice',
  expiresAt: '2026-10-12T10:15:00.000Z', state: 'requested',
  stepUp: false, canDecide: true,
  review: { action: 'Update order', tool: 'write', target: 'order', data: 'note',
    destination: 'Orders', account: 'No account', consequence: 'The note changes.' },
};
const dateFields = ['requestedAt', 'decidedAt', 'usedAt', 'endedAt'] as const;
const invalidDates = [
  '2026-10-12T12:01:00+02:00', '2026-10-12T10:01:00',
  '2026-02-30T10:01:00Z', 'not a date', '', 42, null,
];

function checksSavedDate(field: typeof dateFields[number]) {
  const valid = { ...card, [field]: '2026-10-12T10:01:00.000Z' };
  expect(approvalCardsSchema.safeParse([valid]).success).toBe(true);
  for (const value of invalidDates) {
    const invalid = { ...card, [field]: value };
    expect(approvalCardsSchema.safeParse([invalid]).success, String(value)).toBe(false);
  }
}
it.each(dateFields)('requires a valid UTC instant for %s', checksSavedDate);

function checksPermitUses() {
  expect(approvalCardsSchema.safeParse([card]).success).toBe(true);
  const use = { permitId: 'permit', usedAt: '2026-10-12T10:01:00.000Z' };
  const valid = { ...card, uses: [use] };
  expect(approvalCardsSchema.safeParse([valid]).success).toBe(true);
  const invalidUses: unknown[] = [
    { permitId: 'permit' }, { usedAt: use.usedAt },
    { ...use, permitId: 42 }, { ...use, outcome: 'success' }, null,
  ];
  for (const usedAt of invalidDates) {
    invalidUses.push({ ...use, usedAt });
  }
  for (const invalidUse of invalidUses) {
    const invalid = { ...card, uses: [invalidUse] };
    expect(approvalCardsSchema.safeParse([invalid]).success).toBe(false);
  }
  const notAList = { ...card, uses: use };
  expect(approvalCardsSchema.safeParse([notAList]).success).toBe(false);
}
it('requires each permit use to contain only its id and a valid UTC instant', checksPermitUses);
