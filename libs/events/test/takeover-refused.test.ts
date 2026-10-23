import { expect, it } from 'vitest';
import { getEventDefinition } from '../src/index.ts';

function refusalContract() {
  const definition = getEventDefinition('takeover.refused');
  expect(definition?.stream).toBe('view');
  const schema = definition!.dataSchema;
  const valid = { attemptId: 'attempt', actorId: 'alice', conversationId: 'chat', inputDigest: 'a'.repeat(64),
    reason: 'requester_only' };
  expect(schema.safeParse(valid).success).toBe(true);
  const invalid = [
    { ...valid, reason: 'private-reason-canary' },
    { ...valid, actorId: 'unsafe identity' },
    { ...valid, conversationId: undefined },
    { ...valid, conversationId: 'unsafe.*' },
    { ...valid, attemptId: 'unsafe.*' },
    { ...valid, inputDigest: 'raw-request-canary' },
    { ...valid, affectedTurnIds: ['private-turn-canary'] },
    { ...valid, computerId: 'private-computer' },
    { ...valid, body: 'private-request-canary' },
  ];
  for (const value of invalid) expect(schema.safeParse(value).success).toBe(false);
}
it('allows only safe refusal identifiers, a digest and fixed reasons', refusalContract);
