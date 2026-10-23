import { expect, it } from 'vitest';
import { childRetryInputSchema } from '../src/index.ts';

function rejectsExtraFields(patch: object) {
  const input = { retryId: 'retry', failureEventId: 'failure', ...patch };
  expect(childRetryInputSchema.safeParse(input).success).toBe(false);
}
it.each([{ allowanceBoundCents: 9999 }, { participantIds: ['mallory'] },
  { sourceMessageId: 'other' }, { text: 'private canary' }])(
  'rejects changes to the saved request in retry input: %j', rejectsExtraFields);
function acceptsReferences() {
  const input = { retryId: 'retry', failureEventId: 'failure' };
  expect(childRetryInputSchema.parse(input)).toEqual(input);
}
it('accepts only the two retry references', acceptsReferences);
