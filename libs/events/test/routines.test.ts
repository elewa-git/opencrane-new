import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType } from '../src/index.ts';

const definition = {
  name: 'Daily orders', ownerId: 'alice', ownerAdmissionId: 'joined-alice',
  assistantId: 'sales-assistant', assistantKind: 'team', payingGroupId: 'sales',
  assistantPayingGroupId: 'sales', connectionId: 'odoo', profileId: 'orders-bot',
  profileRevision: 1, companyAccountId: 'verified-bot', scopes: ['orders:read'],
  instructions: { ciphertext: 'ZW5jcnlwdGVk', keyId: 'key:1' },
  schedule: { frequency: 'daily', localTime: '09:00', zone: 'Europe/Brussels' },
};
const slot = { localDate: '2026-10-11', localTime: '09:00', zone: 'Europe/Brussels',
  at: '2026-10-11T07:00:00Z', offsetMinutes: 120 };
const identity = { version: 1, routineId: 'orders', definitionRevision: 1,
  scheduleRevision: 1, controlRevision: 1 };
const created = { ...identity, definition, status: 'paused', actorId: 'alice',
  effectiveAt: '2026-10-10T12:00:00Z', next: slot, cursor: null };
const run = { occurrenceId: 'occurrence', rootId: 'root', conversationId: 'chat',
  messageId: 'message', turnId: 'turn' };
const due = { ...identity, ...run, source: 'scheduled', definition,
  slot, firedAt: '2026-10-11T07:00:00Z', startBy: '2026-10-11T07:01:00Z' };

function envelope(type: string, data: unknown) {
  return { id: type, commandId: 'command', type, data, silo: 'test',
    subject: 'routine-orders', source: 'opencrane-server', time: '2026-10-11T07:00:00Z',
    principal: { kind: 'human', id: 'alice' } };
}
function accepted(type: string, data: unknown) {
  return parseEventByType(envelope(type, data)).success;
}
function readsStrictDefinitions() {
  expect(accepted('routine.created', created)).toBe(true);
  const weekly = { ...definition, schedule: { ...definition.schedule,
    frequency: 'weekly', weekday: 7 } };
  expect(accepted('routine.updated', { ...created, definition: weekly })).toBe(true);
  const legacy = [
    ['routine.created', { routineId: 'orders', assistantId: 'old',
      schedule: '0 9 * * *', createdBy: 'alice' }],
    ['routine.updated', { routineId: 'orders', schedule: '0 8 * * *', updatedBy: 'alice' }],
    ['routine.paused', { routineId: 'orders', pausedBy: 'alice' }],
    ['routine.resumed', { routineId: 'orders', resumedBy: 'alice' }],
    ['routine.retired', { routineId: 'orders', retiredBy: 'alice' }],
    ['routine.due', { routineId: 'orders', firedAt: '2026-10-11T07:00:00Z' }],
  ] as const;
  for (const [type, data] of legacy) {
    expect(accepted(type, data)).toBe(true);
    expect(accepted(type, { ...data, version: 1 })).toBe(false);
  }
}
it('reads modern definitions and exact legacy records', readsStrictDefinitions);

function refusesMixedAndForgedBindings() {
  const badDefinitions = [
    { ...definition, assistantKind: 'personal' },
    { ...definition, payingGroupId: 'other' },
    { ...definition, instructions: { text: 'secret', keyId: 'key:1' } },
    { ...definition, schedule: { ...definition.schedule, weekday: 1 } },
    { ...definition, schedule: { ...definition.schedule, localTime: '24:00' } },
    { ...definition, profileRevision: 1.5 },
  ];
  for (const invalidDefinition of badDefinitions) {
    expect(accepted('routine.created', { ...created, definition: invalidDefinition })).toBe(false);
  }
  expect(accepted('routine.created', { ...created, schedule: '0 9 * * *' })).toBe(false);
  const original = envelope('routine.created', created);
  const forged = [
    { ...original, subject: 'routine-other' },
    { ...original, source: 'computer' },
    { ...original, principal: { kind: 'human', id: 'mallory' } },
    { ...original, commandId: undefined },
  ];
  for (const event of forged) {
    expect(parseEventByType(event).success).toBe(false);
  }
}
it('refuses mixed formats, personal assistants, foreign payers and forged records',
  refusesMixedAndForgedBindings);

function readsRunFactsWithoutActivating() {
  const system = { kind: 'system', id: 'opencrane-server' };
  const event = { ...envelope('routine.due', due), principal: system };
  expect(parseEventByType(event).success).toBe(true);
  expect(accepted('routine.due', due)).toBe(false);
  expect(parseEventByType({ ...event, data: { ...due, firedAt: 'invalid' } }).success).toBe(false);
  const types = ['routine.reassigned', 'routine.occurrence_skipped',
    'routine.occurrences_missed', 'routine.run_activation_admitted',
    'routine.run_stop_requested', 'routine.run_finished'];
  for (const type of types) {
    const registered = getEventDefinition(type);
    expect(registered, type).toBeDefined();
    expect(registered?.dataSchema.safeParse(registered.example).success, type).toBe(true);
  }
}
it('checks frozen run records and registers each new routine fact', readsRunFactsWithoutActivating);
