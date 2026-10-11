import { afterEach, expect, it, vi } from 'vitest';
import { event, natsFixture, countReads, expectNoWholeReads } from '@opencrane/event-store/testing';
import { applyProvider } from '@opencrane/projections';
import { parseEventByType } from '@opencrane/events';
import { turnCommand } from '../src/chat/turns.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let counter = 0;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const input = {
  conversationId: 'chat', turnId: 'message', threadId: 'thread', status: 'started' as const,
};
const provider = { providerId: 'primary', revision: 1, changedBy: 'alice' };
const switchData = { ...provider, expectedProviderSequence: 0 };

async function close() {
  vi.restoreAllMocks();
  await nats?.close();
}
afterEach(close);

async function save(subject: string, type: string, data: unknown) {
  const record = { ...event(`admission-${++counter}`, subject), type, data };
  await nats.seed([record]);
  return nats.store.head(subject);
}

async function setup() {
  nats = await natsFixture();
  await save('conversation-chat', 'conversation.created', {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
  });
  await save('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
  });
  // Use the actual message id as the logical turn id.
  input.turnId = `admission-${counter}`;
  await save('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
  });
  await save('computer-assistant', 'computer.ready', {
    assistantId: 'assistant', computerId: 'computer', generation: 1,
  });
  await save('budget-test', 'budget.ceiling_set', {
    scope: 'global', ceilingCents: 20000, setBy: 'alice', defaultPayingGroupId: 'personal',
  });
  await save('provider-primary', 'provider.created', {
    ...provider, provider: 'openai', name: 'Primary',
  });
}

async function choice(kind: 'assistant' | 'silo_default', state = 'active') {
  const dependantId = kind === 'assistant' ? 'assistant' : 'test';
  const data = {
    ...provider, kind, dependantId, task: 'chat_turn', state, model: 'gpt-6-luna',
    previousBindingSequence: 0, expectedProviderSequence: 0,
  };
  return save('provider-primary', 'provider.model_binding_set', data);
}

async function switchOn() {
  await save('budget-test', 'provider.managed_calls_enabled', switchData);
}

async function usesChoice(kind: 'assistant' | 'silo_default') {
  await setup();
  const bindingSequence = await choice(kind);
  await switchOn();
  const admitted = await turnCommand(nats.store, context, input);
  expect(admitted).toMatchObject({
    providerId: 'primary', bindingSequence, model: 'gpt-6-luna', payingGroupId: 'personal',
  });
  await choice(kind, 'paused');
  const reads = countReads(nats.store);
  const repeated = await turnCommand(nats.store, context, input);
  expect(repeated).toEqual(admitted);
  await turnCommand(nats.store, context, { ...input, status: 'completed' });
  expectNoWholeReads(reads.calls);
}
it.each(['assistant', 'silo_default'] as const)('admits and retains the %s choice', usesChoice);

async function ownPauseOverridesDefault() {
  await setup();
  await choice('silo_default');
  await choice('assistant', 'paused');
  await switchOn();
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow(
    'Model work is paused by an administrator');
}
it('refuses an own pause even when the silo default is active', ownPauseOverridesDefault);

async function ownSelectionOverridesDefault() {
  await setup();
  await choice('silo_default', 'paused');
  const bindingSequence = await choice('assistant');
  await switchOn();
  expect(await turnCommand(nats.store, context, input)).toMatchObject({ bindingSequence });
}
it('uses an own selection even when the silo default is paused', ownSelectionOverridesDefault);

async function refusesMissingChoice() {
  await setup();
  await switchOn();
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow(
    'Choose a provider and model before starting model work');
  const rows = [];
  for await (const row of nats.store.readStream('computer-assistant')) rows.push(row);
  expect(rows.at(-1)?.event).toMatchObject({
    type: 'computer.turn_closed', data: { status: 'failed' },
  });
}
it('records a failed admission when no own or default choice exists', refusesMissingChoice);

async function keepsLegacyAdmission() {
  await setup();
  await choice('assistant', 'paused');
  const admitted = await turnCommand(nats.store, context, input);
  expect(admitted).not.toHaveProperty('providerId');
  expect(admitted).not.toHaveProperty('model');
  await switchOn();
  expect(await turnCommand(nats.store, context, input)).toEqual(admitted);
  await turnCommand(nats.store, context, { ...input, status: 'completed' });
}
it('keeps the old path before switch-on and retains an already recorded turn', keepsLegacyAdmission);

function foldsSwitchWithoutChangingConfiguration() {
  const created = { ...event('provider', 'provider-primary', 'provider.created'),
    data: { ...provider, provider: 'openai', name: 'Primary' } };
  const switched = { ...event('switch', 'budget-test'),
    type: 'provider.managed_calls_enabled', data: switchData };
  expect(parseEventByType(switched).success).toBe(true);
  const initial = applyProvider(undefined, created, 1);
  const state = applyProvider(initial, switched, 2);
  expect(state).toMatchObject({ revision: 1, position: 1, managedCallsEnabled: true });
}
it('validates and folds switch-on without rotating the provider configuration',
  foldsSwitchWithoutChangingConfiguration);

async function refusesModeChangeDuringAdmission() {
  await setup();
  const readStream = nats.store.readStream.bind(nats.store);
  let switched = false;
  let budgetReads = 0;
  async function* switchDuringFinalBudgetRead(subject: string, from?: number, deadline?: number) {
    if (subject === 'budget-test') {
      budgetReads++;
    }
    // Save switch-on after admission read the payer and before its final mode check.
    if (subject === 'budget-test' && budgetReads === 2 && !switched) {
      switched = true;
      await switchOn();
    }
    yield* readStream(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(switchDuringFinalBudgetRead);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow(
    'Provider setup changed; try again');
  expect(switched).toBe(true);
  const rows = [];
  for await (const row of readStream('computer-assistant')) rows.push(row);
  expect(rows).toHaveLength(1);
}
it('refuses a legacy start when switch-on arrives during the final budget check',
  refusesModeChangeDuringAdmission);
