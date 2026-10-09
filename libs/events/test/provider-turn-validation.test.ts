import { expect, it } from 'vitest';
import {
  computerTurnStartedDataSchema, computerTurnClosedDataSchema, getEventDefinition,
} from '../src/index.ts';

const turn = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
};
const choice = { providerId: 'primary', bindingSequence: 42 };
const schemas = [computerTurnStartedDataSchema, computerTurnClosedDataSchema];
const malformedChoices = [
  { ...choice, providerId: 'bad/provider' },
  { ...choice, providerId: 'x'.repeat(201) },
  { ...choice, bindingSequence: 1.5 },
  { ...choice, bindingSequence: Number.MAX_SAFE_INTEGER + 1 },
];

function checksTurnModels(schema: typeof schemas[number]) {
  const legacy = { ...turn, status: 'completed' };
  const fields = schema === computerTurnStartedDataSchema ? turn : legacy;
  expect(schema.safeParse(fields).success).toBe(true);
  const bound = { ...fields, ...choice, model: 'gpt-6-luna' };
  expect(schema.safeParse(bound).success).toBe(true);
  const missingModel = { ...fields, ...choice };
  expect(schema.safeParse(missingModel).success).toBe(false);
  const modelWithoutProvider = { ...fields, model: 'gpt-6-luna' };
  expect(schema.safeParse(modelWithoutProvider).success).toBe(false);
}
it.each(schemas)('requires a model exactly when a turn record names a provider (%#)',
  checksTurnModels);

const incompleteChoices = [
  { providerId: 'primary', model: 'gpt-6-luna' },
  { bindingSequence: 42 },
];
function refusesIncompleteClosure(patch: Record<string, unknown>) {
  const closed = { ...turn, status: 'completed', ...patch };
  expect(computerTurnClosedDataSchema.safeParse(closed).success).toBe(false);
}
it.each(incompleteChoices)('refuses an incomplete provider choice on closure %j',
  refusesIncompleteClosure);

function refusesMalformedStoredChoice(patch: Record<string, unknown>) {
  const started = { ...turn, ...patch, model: 'gpt-6-luna' };
  const closed = { ...started, status: 'completed' };
  expect(computerTurnStartedDataSchema.safeParse(started).success).toBe(false);
  expect(computerTurnClosedDataSchema.safeParse(closed).success).toBe(false);
  const modelCall = {
    ...patch, model: 'gpt-6-luna', priceTableId: 'tariff', computerId: 'computer',
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', contextDigest: 'a'.repeat(64),
  };
  const reservation = {
    reservationId: 'reservation', permitId: 'permit', amountCents: 12, modelCall,
    payingGroupId: 'group', assistantId: 'assistant',
  };
  const schema = getEventDefinition('budget.reserved')!.dataSchema;
  expect(schema.safeParse(reservation).success).toBe(false);
}
it.each(malformedChoices)('refuses malformed provider identity in stored records %j',
  refusesMalformedStoredChoice);
