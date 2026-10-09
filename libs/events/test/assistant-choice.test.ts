import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType } from '../src/index.ts';

function membershipEvent(type: string, personalAssistant?: unknown) {
  const definition = getEventDefinition(type);
  const example = definition?.example;
  if (!example || typeof example !== 'object') {
    throw new Error('Membership example missing');
  }
  const data = { ...example, personalAssistant };
  return {
    id: 'membership-choice', commandId: 'membership-choice', type, data,
    subject: 'member-alice', silo: 'acme', source: 'test',
    time: '2026-10-01T12:00:00Z', principal: { kind: 'human', id: 'alice' },
  };
}

const membershipTypes = ['member.invited', 'member.joined'];
const choices = ['provision', 'none', undefined];
function acceptsAssistantChoices(type: string) {
  for (const choice of choices) {
    const input = membershipEvent(type, choice);
    const result = parseEventByType(input);
    expect(result.success, `${type}: ${String(choice)}`).toBe(true);
  }
}
it.each(membershipTypes)('%s accepts an assistant choice and older events without it',
  acceptsAssistantChoices);

function refusesInvalidChoices(type: string) {
  for (const choice of ['owner', '', true, null]) {
    const input = membershipEvent(type, choice);
    expect(parseEventByType(input).success).toBe(false);
  }
}
it.each(membershipTypes)('%s refuses an invalid assistant choice', refusesInvalidChoices);

function keepsBootstrapChoiceUnavailable() {
  const input = membershipEvent('silo.owner_bootstrapped', 'none');
  expect(parseEventByType(input).success).toBe(false);
}
it('keeps the first owner bootstrap separate from invitation assistant choices',
  keepsBootstrapChoiceUnavailable);
