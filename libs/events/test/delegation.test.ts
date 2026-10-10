import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType } from '../src/index.ts';

const binding = {
  delegationId: 'child', rootId: 'root', rootTurnId: 'root-turn', rootThreadId: 'root-thread',
  assistantId: 'assistant', computerId: 'computer', generation: 1,
  conversationId: 'chat', requesterId: 'alice', payingGroupId: 'sales',
  parentTurnId: 'root-turn', parentThreadId: 'root-thread', turnId: 'child-turn',
  threadId: 'child-thread', spawnItemId: 'spawn', contentClass: 'private',
  scopes: { models: ['gpt-6-luna'], tools: [], resources: [], operations: [],
    destinations: [], connectionIds: [], profileIds: [] },
};
const started = { ...binding, version: 1, computerAdmission: { eventId: 'admission', position: 1 } };
const completed = { version: 1, delegationId: 'child', outcome: 'cancelled',
  reason: 'root_stopped', terminalEvidence: { eventId: 'closed', position: 4 } };

function envelope(type: string, data: unknown) {
  return { id: 'event', commandId: 'command', type, data, silo: 'test',
    subject: 'delegation-child', source: 'opencrane-server', time: '2026-10-10T10:00:00Z',
    principal: { kind: 'system', id: 'opencrane-server' } };
}
function schema(type: string) {
  const definition = getEventDefinition(type);
  if (!definition) throw new Error('Missing delegation definition');
  return definition.dataSchema;
}
function readsModernAndLegacyRecords() {
  expect(schema('delegation.started').safeParse(started).success).toBe(true);
  expect(schema('delegation.completed').safeParse(completed).success).toBe(true);
  const legacy = { delegationId: 'child', parentComputerId: 'old-parent',
    childComputerId: 'old-child', rootBudgetId: 'old-budget' };
  expect(parseEventByType(envelope('delegation.started', legacy)).success).toBe(true);
  const legacyOutcome = { delegationId: 'child', outcome: 'success' };
  expect(parseEventByType(envelope('delegation.completed', legacyOutcome)).success).toBe(true);
}
it('reads modern task bindings and exact legacy records', readsModernAndLegacyRecords);

function refusesMixedAndForgedRecords() {
  const mixed = { ...started, childComputerId: 'foreign-computer' };
  const selfParent = { ...started, parentThreadId: binding.threadId };
  const unsafeGeneration = { ...started, generation: 1.5 };
  const noAdmission = { ...started, computerAdmission: undefined };
  const mixedOutcome = { ...completed, outcome: 'success' };
  for (const data of [mixed, selfParent, unsafeGeneration, noAdmission]) {
    expect(schema('delegation.started').safeParse(data).success).toBe(false);
  }
  expect(schema('delegation.completed').safeParse(mixedOutcome).success).toBe(false);
  const wrongSubject = { ...envelope('delegation.started', started), subject: 'delegation-other' };
  const forgedSource = { ...envelope('delegation.started', started), source: 'computer' };
  const forgedPrincipal = { ...envelope('delegation.started', started),
    principal: { kind: 'human', id: 'alice' } };
  for (const event of [wrongSubject, forgedSource, forgedPrincipal]) {
    expect(parseEventByType(event).success).toBe(false);
  }
}
it('refuses mixed formats, self-parent links and forged server records', refusesMixedAndForgedRecords);

function readsNativeComputerRecords() {
  const native = { ...binding, task: 'native_descendant', executionMode: 'restricted' };
  expect(schema('computer.turn_started').safeParse(native).success).toBe(true);
  const closed = { ...native, status: 'cancelled' };
  expect(schema('computer.turn_closed').safeParse(closed).success).toBe(true);
  const mixed = { ...native, task: 'chat_turn' };
  expect(schema('computer.turn_started').safeParse(mixed).success).toBe(false);
}
it('keeps native computer records separate from chat starts', readsNativeComputerRecords);
