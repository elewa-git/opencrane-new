import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerHandler } from '@opencrane/handlers';
import {
  assistantCreatedDataSchema, providerBindingSchema, providerIdSchema,
  providerModelIdSchema, type EventEnvelope,
} from '@opencrane/events';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { applyProvider, type ProviderState, type Query } from '@opencrane/projections';
import { history } from './actor.ts';
import { readActiveMember } from './member-authority.ts';
import { modelForTask } from './routing.ts';
import { models } from './state.ts';
import { providerRoutinePresence } from './provider-routine-presence.ts';
import {
  ProviderConflict, ProviderRefused, providerAuthority, providerPermission,
  providerReceipt, providerSecretRef,
} from './providers.ts';

const sequence = z.int().nonnegative();
const common = {
  commandId: providerIdSchema,
  expectedProviderSequence: sequence,
  expectedRevision: z.int().positive(),
  expectedSourceRevision: z.int().positive().optional(),
  kind: z.enum(['assistant', 'silo_default']),
  dependantId: providerIdSchema,
  task: z.literal('chat_turn'),
  expectedBindingSequence: sequence,
};
const selection = { ...common, action: z.literal('select'), model: providerModelIdSchema };
const pause = { ...common, action: z.literal('pause') };
const commandSchema = z.discriminatedUnion('action', [
  z.object(selection).strict(), z.object(pause).strict(),
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
    if (!firstVerified && state.lastReachable?.changeId === row.event.id) {
      firstVerified = providerId;
    }
    if (row.event.type === 'provider.model_binding_set') {
      const choice = { ...providerBindingSchema.parse(row.event.data), position: row.sequence };
      bindings.set(choiceKey(choice), choice);
    }
  }
  return { rows, providers, bindings, firstVerified, position: rows.at(-1)?.sequence ?? 0 };
}

function connectionRows(rows: StoredEvent[], providerId: string) {
  function belongs(row: StoredEvent) {
    return row.event.subject === `provider-${providerId}`;
  }
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
  return recordBinding(store, binding, memberId, providerId, input);
}

async function recordBinding(store: EventStore, binding: Binding, memberId: string,
  providerId: string, input: BindingInput) {
  // Read growing histories before starting the short access check.
  const current = await inventory(store, binding.silo);
  const previous = current.bindings.get(choiceKey(input));
  if (input.kind === 'silo_default') {
    if (input.dependantId !== binding.silo) {
      throw new ProviderRefused();
    }
  } else {
    const assistants = await history(store, `assistant-${input.dependantId}`,
      binding.silo, performance.now() + 10_000);
    const created = assistants.find(isAssistantCreation);
    if (!created) {
      throw new ProviderRefused();
    }
    assistantCreatedDataSchema.parse(created.event.data);
  }
  const fresh = await providerAuthority(store, binding, memberId);
  await providerPermission(binding, memberId, connectionRows(current.rows, providerId));
  function matches(row: StoredEvent) {
    return row.event.subject === `provider-${providerId}` &&
      row.event.commandId === input.commandId;
  }
  const original = current.rows.find(matches);
  if (!original) {
    await checkBinding(current, input, providerId, binding, memberId, previous);
  }
  const payload = bindingPayload(input, providerId, memberId, previous, original);
  if (original) {
    reconcileBinding(original, binding.silo, providerId, input.commandId, memberId, payload);
    await fresh();
    return providerReceipt(original);
  }
  const event: EventEnvelope = {
    id: randomUUID(), commandId: input.commandId, subject: `provider-${providerId}`,
    silo: binding.silo, type: 'provider.model_binding_set', data: payload,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human', id: memberId },
  };
  const command = {
    event, expectedSequence: current.position, expectedSubject: 'provider-*',
    historyChecked: true as const, deadline: fresh.deadline,
  };
  await fresh();
  const result = await store.append(command);
  if (result.status === 'conflict') {
    throw new ProviderConflict();
  }
  if (result.status !== 'appended') {
    throw new Error('Binding append unavailable');
  }
  // Read the saved event because duplicate recovery can return an earlier request's position.
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) {
    throw new Error('Saved binding unavailable');
  }
  reconcileBinding(saved, binding.silo, providerId, input.commandId, memberId, payload);
  return providerReceipt(saved);
}

function reconcileBinding(saved: StoredEvent, silo: string, providerId: string,
  commandId: string, memberId: string, payload: z.infer<typeof providerBindingSchema>) {
  const event = saved.event;
  if (event.silo !== silo || event.subject !== `provider-${providerId}` ||
    event.commandId !== commandId || event.principal?.kind !== 'human' ||
    event.principal.id !== memberId || event.type !== 'provider.model_binding_set' ||
    JSON.stringify(event.data) !== JSON.stringify(payload)) {
    throw new ProviderConflict();
  }
}

function bindingPayload(input: BindingInput, providerId: string, memberId: string,
  previous: Choice | undefined, original: StoredEvent | undefined) {
  let model = previous?.model;
  if (input.action === 'select') {
    model = input.model;
  } else if (original?.event.type === 'provider.model_binding_set') {
    model = providerBindingSchema.parse(original.event.data).model;
  }
  const payload = {
    providerId, revision: input.expectedRevision, changedBy: memberId,
    kind: input.kind, dependantId: input.dependantId, task: input.task,
    previousBindingSequence: input.expectedBindingSequence,
    expectedProviderSequence: input.expectedProviderSequence,
    ...(input.expectedSourceRevision ? { sourceRevision: input.expectedSourceRevision } : {}),
    state: input.action === 'select' ? 'active' : 'paused', model,
    ...(input.action === 'pause' ? { reason: 'Paused by an administrator' } : {}),
  };
  return providerBindingSchema.parse(payload);
}

async function checkBinding(current: Inventory, input: BindingInput, providerId: string,
  binding: Binding, memberId: string, previous: Choice | undefined) {
  const target = current.providers.get(providerId);
  if (current.position !== input.expectedProviderSequence ||
    target?.revision !== input.expectedRevision ||
    (previous?.position ?? 0) !== input.expectedBindingSequence) {
    throw new ProviderConflict();
  }
  if (previous && previous.providerId !== providerId) {
    await providerPermission(binding, memberId, connectionRows(current.rows, previous.providerId));
    if (current.providers.get(previous.providerId)?.revision !== input.expectedSourceRevision) {
      throw new ProviderConflict();
    }
  }
  if (input.action === 'select') {
    checkSelection(current, providerId, binding.silo);
    requireSelectable(target, input.model);
  } else if (!previous || previous.providerId !== providerId) {
    throw new ProviderConflict();
  }
}

function checkSelection(current: Inventory, providerId: string, silo: string) {
  function isKey(row: StoredEvent) {
    return row.event.type === 'provider.key_saved';
  }
  const rows = connectionRows(current.rows, providerId);
  const key = rows.findLast(isKey);
  // Keep provider keys in the silo that owns this choice.
  if (!key?.event.commandId || current.providers.get(providerId)?.secretRef !==
    providerSecretRef(silo, providerId, key.event.commandId)) {
    throw new ProviderRefused();
  }
}

function isAssistantCreation(row: StoredEvent) {
  return row.event.type === 'assistant.created';
}

async function checkedHistory(store: EventStore, silo: string, subject: string, deadline: number) {
  const position = await store.head(subject, deadline);
  const rows = await history(store, subject, silo, deadline);
  if ((rows.at(-1)?.sequence ?? 0) !== position ||
    await store.head(subject, deadline) !== position) {
    throw new Error('History changed');
  }
  return rows;
}

async function providerCreation(store: EventStore, silo: string, providerId: string) {
  const subject = `provider-${providerId}`;
  const deadline = performance.now() + 10_000;
  // Read only the creation record needed for permission, even if the inventory fails.
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo || row.event.subject !== subject ||
      row.event.type !== 'provider.created') {
      throw new Error('Provider creation unavailable');
    }
    return [row];
  }
  return [];
}

async function prepareDependencies(store: EventStore, db: Query, silo: string) {
  const current = await inventory(store, silo);
  const deadline = performance.now() + 10_000;
  const assistants = await checkedHistory(store, silo, 'assistant-*', deadline);
  const routines = await providerRoutinePresence(store, db, silo, deadline);
  if (await store.head('provider-*', deadline) !== current.position) {
    throw new Error('Provider history changed');
  }
  return { current, assistants, routines };
}

export async function providerDependencies(store: EventStore, binding: Binding,
  memberId: string, providerId: string, db: Query) {
  const creation = providerCreation(store, binding.silo, providerId);
  const [provider] = await Promise.allSettled([creation]);
  const loading = prepareDependencies(store, db, binding.silo);
  const [prepared] = await Promise.allSettled([loading]);
  await readActiveMember(store, binding, memberId, 'admin');
  if (provider.status === 'rejected') {
    throw new Error('Provider dependencies unavailable');
  }
  await providerPermission(binding, memberId, provider.value);
  // Check current rights before disclosing any failed dependency preparation.
  if (prepared.status === 'rejected') {
    throw new Error('Provider dependencies unavailable');
  }
  const { current, assistants, routines } = prepared.value;
  const assistantIds = new Set<string>();
  for (const row of assistants) {
    if (isAssistantCreation(row)) {
      assistantIds.add(assistantCreatedDataSchema.parse(row.event.data).assistantId);
    }
  }
  const rows = [];
  for (const choice of current.bindings.values()) {
    if (choice.providerId !== providerId) {
      continue;
    }
    let assistantCount = choice.kind === 'assistant' ? 1 : 0;
    if (choice.kind === 'silo_default') {
      for (const assistantId of assistantIds) {
        const own = { kind: 'assistant' as const, dependantId: assistantId, task: choice.task };
        if (!current.bindings.has(choiceKey(own))) {
          assistantCount++;
        }
      }
    }
    rows.push({ ...choice, assistantCount });
  }
  return {
    rows, expectedProviderSequence: current.position, ordinaryCallsAvailable: false,
    routines: { status: routines.status, position: routines.position },
  };
}

export function providerDefaultHandler(store: EventStore, binding: Binding) {
  async function recordDefault(trigger: EventEnvelope) {
    if (trigger.silo !== binding.silo) {
      throw new ProviderRefused();
    }
    const current = await inventory(store, binding.silo);
    const identity = {
      kind: 'silo_default' as const, dependantId: binding.silo, task: 'chat_turn' as const,
    };
    if (current.bindings.has(choiceKey(identity)) || !current.firstVerified) {
      return;
    }
    const target = current.providers.get(current.firstVerified);
    const model = modelForTask('chat_turn');
    if (!target?.enabledModels.includes(model)) {
      return;
    }
    const actorSchema = z.object({ changedBy: providerIdSchema });
    const changedBy = actorSchema.parse(trigger.data).changedBy;
    // Reserve an id containing a colon, which user provider commands cannot supply.
    const command: BindingInput = {
      ...identity, commandId: 'system:seed-provider-default',
      expectedProviderSequence: current.position, expectedRevision: target.revision,
      expectedBindingSequence: 0, action: 'select', model,
    };
    await recordBinding(store, binding, changedBy, target.providerId, command);
  }
  return registerHandler('seed-provider-default', recordDefault);
}
