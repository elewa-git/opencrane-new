import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerHandler } from '@opencrane/handlers';
import { assistantCreatedDataSchema, providerBindingSchema, providerIdSchema,
  providerModelIdSchema, type EventEnvelope } from '@opencrane/events';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { applyProvider, type ProviderState } from '@opencrane/projections';
import { history } from './actor.ts';
import { readActiveMember } from './member-authority.ts';
import { modelForTask } from './routing.ts';
import { models } from './state.ts';
import { ProviderConflict, ProviderRefused, providerAuthority, providerPermission,
  providerReceipt, providerSecretRef } from './providers.ts';
const sequence = z.int().nonnegative();
const common = { commandId: providerIdSchema, expectedProviderSequence: sequence,
  expectedRevision: z.int().positive(), expectedSourceRevision: z.int().positive().optional(),
  kind: z.enum(['assistant', 'silo_default']), dependantId: providerIdSchema,
  task: z.literal('chat_turn'), expectedBindingSequence: sequence };
const commandSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('select'), model: providerModelIdSchema }).strict(),
  z.object({ ...common, action: z.literal('pause') }).strict(),
]);
type BindingInput = z.infer<typeof commandSchema>;
type Inventory = Awaited<ReturnType<typeof inventory>>;
type Choice = z.infer<typeof providerBindingSchema> & { position: number };
function choiceKey(choice: Pick<Choice, 'kind' | 'dependantId' | 'task'>) {
  return JSON.stringify([choice.kind, choice.dependantId, choice.task]);
}
async function inventory(store: EventStore, silo: string) {
  const rows = await history(store, 'provider-*', silo, performance.now() + 10_000);
  const providers = new Map<string, ProviderState>();
  const bindings = new Map<string, Choice>();
  let firstVerified: string | undefined;
  for (const row of rows) {
    const providerId = row.event.subject.slice('provider-'.length);
    const state = applyProvider(providers.get(providerId), row.event, row.sequence);
    providers.set(providerId, state);
    if (!firstVerified && state.lastReachable?.changeId === row.event.id) firstVerified = providerId;
    if (row.event.type === 'provider.model_binding_set') {
      const choice = { ...providerBindingSchema.parse(row.event.data), position: row.sequence };
      bindings.set(choiceKey(choice), choice);
    }
  }
  return { rows, providers, bindings, firstVerified, position: rows.at(-1)?.sequence ?? 0 };
}
function connectionRows(rows: StoredEvent[], providerId: string) {
  function belongs(row: StoredEvent) { return row.event.subject === `provider-${providerId}`; }
  return rows.filter(belongs);
}
function requireSelectable(state: ProviderState | undefined, model: string) {
  function supported(candidate: (typeof models)[number]) {
    return candidate.id === model && !candidate.retired;
  }
  if (!state || state.provider !== 'openai' || !state.secretRef ||
    !state.lastReachable || !state.enabledModels.includes(model) || !models.some(supported)) {
    throw new ProviderRefused();
  }
}
export async function providerBindingCommand(store: EventStore, binding: Binding,
  memberId: string, providerId: string, raw: unknown) {
  providerIdSchema.parse(providerId);
  const input = commandSchema.parse(raw);
  // Read growing histories before starting the short access check.
  const current = await inventory(store, binding.silo);
  const previous = current.bindings.get(choiceKey(input));
  if (input.kind === 'silo_default') {
    if (input.dependantId !== binding.silo) throw new ProviderRefused();
  } else {
    const assistants = await history(store, `assistant-${input.dependantId}`,
      binding.silo, performance.now() + 10_000);
    const created = assistants.find(isAssistantCreation);
    if (!created) throw new ProviderRefused();
    assistantCreatedDataSchema.parse(created.event.data);
  }
  const fresh = await providerAuthority(store, binding, memberId);
  await providerPermission(binding, memberId, connectionRows(current.rows, providerId));
  function matches(row: StoredEvent) {
    return row.event.subject === `provider-${providerId}` &&
      row.event.commandId === input.commandId && row.event.principal?.id === memberId;
  }
  const original = current.rows.find(matches);
  if (!original) await checkBinding(current, input, providerId, binding, memberId, previous);
  const payload = bindingPayload(input, providerId, memberId, previous, original);
  if (original) {
    if (original.event.type !== 'provider.model_binding_set' ||
      JSON.stringify(original.event.data) !== JSON.stringify(payload)) throw new ProviderConflict();
    await fresh();
    return providerReceipt(original);
  }
  const event = { id: randomUUID(), commandId: input.commandId, subject: `provider-${providerId}`,
    silo: binding.silo, type: 'provider.model_binding_set', data: payload,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  await fresh();
  const result = await store.append({ event, expectedSequence: current.position,
    expectedSubject: 'provider-*', historyChecked: true, deadline: fresh.deadline });
  if (result.status === 'conflict') throw new ProviderConflict();
  if (result.status !== 'appended') throw new Error('Binding append unavailable');
  return providerReceipt({ event, sequence: result.sequence });
}
function bindingPayload(input: BindingInput, providerId: string, memberId: string,
  previous: Choice | undefined, original: StoredEvent | undefined) {
  let model = previous?.model;
  if (input.action === 'select') model = input.model;
  else if (original?.event.type === 'provider.model_binding_set') {
    model = providerBindingSchema.parse(original.event.data).model;
  }
  const payload = { providerId, revision: input.expectedRevision, changedBy: memberId,
    kind: input.kind, dependantId: input.dependantId, task: input.task,
    previousBindingSequence: input.expectedBindingSequence,
    expectedProviderSequence: input.expectedProviderSequence,
    ...(input.expectedSourceRevision ? { sourceRevision: input.expectedSourceRevision } : {}),
    state: input.action === 'select' ? 'active' : 'paused', model,
    ...(input.action === 'pause' ? { reason: 'Paused by an administrator' } : {}) };
  return providerBindingSchema.parse(payload);
}
async function checkBinding(current: Inventory, input: BindingInput, providerId: string,
  binding: Binding, memberId: string, previous: Choice | undefined) {
  const target = current.providers.get(providerId);
  if (current.position !== input.expectedProviderSequence ||
    target?.revision !== input.expectedRevision ||
    (previous?.position ?? 0) !== input.expectedBindingSequence) throw new ProviderConflict();
  if (previous && previous.providerId !== providerId) {
    await providerPermission(binding, memberId, connectionRows(current.rows, previous.providerId));
    if (current.providers.get(previous.providerId)?.revision !== input.expectedSourceRevision) {
      throw new ProviderConflict();
    }
  }
  if (input.action === 'select') {
    checkSelection(current, input, providerId, binding.silo, previous);
    requireSelectable(target, input.model);
  } else if (!previous || previous.providerId !== providerId) {
    throw new ProviderConflict();
  }
}
function checkSelection(current: Inventory, input: BindingInput, providerId: string,
  silo: string, previous: Choice | undefined) {
  if (input.kind === 'silo_default' && !previous && providerId !== current.firstVerified) {
    throw new ProviderRefused();
  }
  function isKey(row: StoredEvent) { return row.event.type === 'provider.key_saved'; }
  const rows = connectionRows(current.rows, providerId);
  const key = rows.findLast(isKey);
  // Keep provider keys in the silo that owns this choice.
  if (!key?.event.commandId || current.providers.get(providerId)?.secretRef !==
    providerSecretRef(silo, providerId, key.event.commandId)) throw new ProviderRefused();
}
function isAssistantCreation(row: StoredEvent) { return row.event.type === 'assistant.created'; }
async function checkedHistory(store: EventStore, silo: string, subject: string, deadline: number) {
  const position = await store.head(subject, deadline);
  const rows = await history(store, subject, silo, deadline);
  if ((rows.at(-1)?.sequence ?? 0) !== position ||
    await store.head(subject, deadline) !== position) throw new Error('History changed');
  return rows;
}
export async function providerDependencies(store: EventStore, binding: Binding,
  memberId: string, providerId: string) {
  const current = await inventory(store, binding.silo);
  const deadline = performance.now() + 10_000;
  const assistants = await checkedHistory(store, binding.silo, 'assistant-*', deadline);
  const routines = await checkedHistory(store, binding.silo, 'routine-*', deadline);
  if (await store.head('provider-*', deadline) !== current.position) {
    throw new Error('Provider history changed');
  }
  await readActiveMember(store, binding, memberId, 'admin');
  await providerPermission(binding, memberId, connectionRows(current.rows, providerId));
  const assistantIds = new Set<string>();
  for (const row of assistants) {
    if (isAssistantCreation(row)) {
      assistantIds.add(assistantCreatedDataSchema.parse(row.event.data).assistantId);
    }
  }
  const rows = [];
  for (const choice of current.bindings.values()) {
    if (choice.providerId !== providerId) continue;
    let assistantCount = choice.kind === 'assistant' ? 1 : 0;
    if (choice.kind === 'silo_default') {
      for (const assistantId of assistantIds) {
        const own = { kind: 'assistant' as const, dependantId: assistantId, task: choice.task };
        if (!current.bindings.has(choiceKey(own))) assistantCount++;
      }
    }
    rows.push({ ...choice, assistantCount });
  }
  return { rows, expectedProviderSequence: current.position, ordinaryCallsAvailable: false,
    routines: { status: routines.length ? 'unsupported' : 'absent',
      position: routines.at(-1)?.sequence ?? 0 } };
}
export function providerDefaultHandler(store: EventStore, binding: Binding) {
  async function recordDefault(trigger: EventEnvelope) {
    if (trigger.silo !== binding.silo) throw new ProviderRefused();
    const current = await inventory(store, binding.silo);
    const identity = { kind: 'silo_default' as const, dependantId: binding.silo,
      task: 'chat_turn' as const };
    if (current.bindings.has(choiceKey(identity)) || !current.firstVerified) return;
    const target = current.providers.get(current.firstVerified);
    const model = modelForTask('chat_turn');
    if (!target?.enabledModels.includes(model)) return;
    const changedBy = z.object({ changedBy: providerIdSchema }).parse(trigger.data).changedBy;
    const command = { ...identity, commandId: 'initial-default',
      expectedProviderSequence: current.position, expectedRevision: target.revision,
      expectedBindingSequence: 0, action: 'select', model };
    await providerBindingCommand(store, binding, changedBy, target.providerId, command);
  }
  return registerHandler('seed-provider-default', recordDefault);
}
