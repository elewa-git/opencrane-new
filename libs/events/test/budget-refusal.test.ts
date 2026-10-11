import { expect, it } from 'vitest';
import { budgetExhaustedDataSchema } from '../src/index.ts';

const refusedWork = { conversationId: 'conversation', turnId: 'turn' };
const refusal = { stopId: 'existing-stop', work: refusedWork };

function acceptsStopReference() {
  expect(budgetExhaustedDataSchema.parse(refusal)).toEqual(refusal);
}
it('accepts a refused turn with the existing stop it hit', acceptsStopReference);

const invalidRefusals = [
  { work: refusedWork },
  { stopId: '', work: refusedWork },
  { stopId: 'existing-stop' },
  { stopId: 'existing-stop', work: { conversationId: '', turnId: 'turn' } },
  { stopId: 'existing-stop', work: { conversationId: 'conversation', turnId: '' } },
  { stopId: 'existing-stop', work: { conversationId: 'conversation' } },
  { stopId: 'existing-stop', work: { turnId: 'turn' } },
  { ...refusal, scope: 'global' },
  { ...refusal, reasons: [] },
  { ...refusal, undeclared: true },
  { stopId: 'existing-stop', work: { ...refusedWork, undeclared: true } },
];
function rejectsIncompleteOrMixedRefusal(payload: unknown) {
  expect(budgetExhaustedDataSchema.safeParse(payload).success).toBe(false);
}
it.each(invalidRefusals)('rejects an incomplete or mixed stop-reference record: %j',
  rejectsIncompleteOrMixedRefusal);
