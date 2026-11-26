import { serverEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { registerHandler } from '@opencrane/handlers';
import {
  assistantCreatedDataSchema, providerBindingSchema, providerRetiredSchema, providerIdSchema,
  providerModelIdSchema, type EventEnvelope,
} from '@opencrane/events';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { applyProvider, retirementBinding, type ProviderState, type Query } from '@opencrane/projections';
import { history } from './actor.ts';
import { readActiveMember } from './member-authority.ts';
import { modelForTask } from './routing.ts';
import { models } from './state.ts';
import { providerRoutinePresence } from './provider-routine-presence.ts';
import {
  ProviderChoiceRefused, ProviderConflict, ProviderRefused, providerAuthority, providerPermission,
  providerReceipt, providerSecretRef, providerStatus,
} from './providers.ts';

const sequence = z.int().nonnegative();
const automaticDefaultCommandId = 'system:seed-provider-default';
const positions = {
  commandId: providerIdSchema,
  expectedProviderSequence: sequence,
  expectedRevision: z.int().positive(),
  expectedSourceRevision: z.int().positive().optional(),
  expectedBindingSequence: sequence,
};
const identity = {
  kind: z.enum(['assistant', 'silo_default']),
  dependantId: providerIdSchema,
  task: z.literal('chat_turn'),
};
const common = { ...positions, ...identity };
const selection = { ...positions, model: providerModelIdSchema };
const select = { ...selection, ...identity, action: z.literal('select') };
const selectChatDefault = { ...selection, action: z.literal('select_chat_default') };
const pause = { ...common, action: z.literal('pause') };
const commandSchema = z.discriminatedUnion('action', [
  z.object(select).strict(), z.object(pause).strict(), z.object(selectChatDefault).strict(),
]);
type Inventory = Awaited<ReturnType<typeof inventory>>;
type BindingPayload = z.infer<typeof providerBindingSchema>;
export type Choice = BindingPayload & { position: number };
type BindingIdentity = Pick<Choice, 'kind' | 'dependantId' | 'task'>;
type BindingInput = z.infer<typeof commandSchema> & BindingIdentity;

export function choiceKey(choice: BindingIdentity) {
  return JSON.stringify([choice.kind, choice.dependantId, choice.task]);
}

function bindingChoice(current: Inventory, choice: BindingIdentity) {
  return current.bindings.get(choiceKey(choice));
}

function chatDefaultIdentity(silo: string) {
  return { kind: 'silo_default' as const, dependantId: silo, task: 'chat_turn' as const };
}

export async function inventory(store: EventStore, silo: string) {
  const rows = await history(store, 'provider-*', silo, performance.now() + 10_000);
  const providers = new Map<string, ProviderState>();
  const bindings = new Map<string, Choice>();
  let firstVerified: string | undefined;
  for (const row of rows) {
    const providerId = row.event.subject.slice('provider-'.length);
    const state = applyProvider(providers.get(providerId), row.event, row.sequence);
    providers.set(providerId, state);
    if (!firstVerified && !state.retired && state.lastReachable?.changeId === row.event.id) {
      firstVerified = providerId;
    }
    if (row.event.type === 'provider.model_binding_set') {
      const choice = { ...providerBindingSchema.parse(row.event.data), position: row.sequence };
      bindings.set(choiceKey(choice), choice);
    }
    if (row.event.type === 'provider.retired') {
      const retirement = providerRetiredSchema.parse(row.event.data);
      for (const reviewed of retirement.choices) {
        const choice = retirementBinding(retirement, reviewed, row.sequence);
        bindings.set(choiceKey(choice), choice);
      }
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

function requireSelectable(target: ProviderState, model: string, needsAnswer: boolean) {
  function supported(candidate: (typeof models)[number]) {
    return candidate.id === model && !candidate.retired;
  }
  if (target.provider !== 'openai') {
    throw new ProviderChoiceRefused('connection_not_ready');
  }
  const ready = needsAnswer ? providerStatus(target) === 'ready'
    : !target.retired && !!target.lastReachable;
  if (!ready) {
    throw new ProviderChoiceRefused('connection_not_ready');
  }
  if (!target.enabledModels.includes(model) || !models.some(supported)) {
    throw new ProviderChoiceRefused('model_not_enabled');
  }
}

export async function providerBindingCommand(store: EventStore, binding: Binding,
  memberId: string, providerId: string, raw: unknown) {
  providerIdSchema.parse(providerId);
  const command = commandSchema.parse(raw);
  // Use this installation so the request cannot name a default in another one.
  const input = command.action === 'select_chat_default'
    ? { ...command, ...chatDefaultIdentity(binding.silo) }
    : command;
  return recordBinding(store, binding, memberId, providerId, input);
}

async function recordBinding(store: EventStore, binding: Binding, memberId: string,
  providerId: string, input: BindingInput) {
  // Read growing histories before starting the short access check.
  const current = await inventory(store, binding.silo);
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
  if (original) {
    // Use the saved choice to check a retry even if the default has since moved.
    const recorded = parseBinding(original);
    const payload = bindingPayload(input, providerId, memberId, recorded, !!recorded.sourceRevision);
    reconcileBinding(original, binding.silo, input.commandId, recorded, payload);
    await fresh();
    return providerReceipt(original);
  }
  const previous = await checkBinding(current, input, providerId, binding, memberId);
  const moved = previous !== undefined && previous.providerId !== providerId;
  const payload = bindingPayload(input, providerId, memberId, previous, moved);
  const event: EventEnvelope = serverEvent({
    commandId: input.commandId, subject: `provider-${providerId}`,
    silo: binding.silo, type: 'provider.model_binding_set', data: payload,
    principal: { kind: 'human', id: memberId },
  });
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
  const recorded = parseBinding(saved);
  reconcileBinding(saved, binding.silo, input.commandId, recorded, payload);
  return providerReceipt(saved);
}

function parseBinding(row: StoredEvent): BindingPayload {
  if (row.event.type !== 'provider.model_binding_set') {
    throw new ProviderConflict();
  }
  const parsed = providerBindingSchema.safeParse(row.event.data);
  if (!parsed.success) {
    throw new ProviderConflict();
  }
  return parsed.data;
}

function sameBinding(left: BindingPayload, right: BindingPayload): boolean {
  return left.providerId === right.providerId && left.revision === right.revision &&
    left.kind === right.kind &&
    left.dependantId === right.dependantId && left.task === right.task &&
    left.expectedProviderSequence === right.expectedProviderSequence &&
    left.previousBindingSequence === right.previousBindingSequence &&
    left.sourceRevision === right.sourceRevision && left.state === right.state &&
    left.model === right.model && left.reason === right.reason;
}

function reconcileBinding(saved: StoredEvent, silo: string, commandId: string,
  recorded: BindingPayload, payload: BindingPayload) {
  const event = saved.event;
  if (event.silo !== silo || event.subject !== `provider-${payload.providerId}` ||
    event.commandId !== commandId || event.principal?.kind !== 'human' ||
    recorded.changedBy !== event.principal.id || event.principal.id !== payload.changedBy ||
    !sameBinding(recorded, payload)) {
    throw new ProviderConflict();
  }
}

function bindingPayload(input: BindingInput, providerId: string, memberId: string,
  previous: BindingPayload | undefined, hasSourceRevision: boolean) {
  const model = input.action === 'pause' ? previous?.model : input.model;
  const payload = {
    providerId, revision: input.expectedRevision, changedBy: memberId,
    kind: input.kind, dependantId: input.dependantId, task: input.task,
    previousBindingSequence: input.expectedBindingSequence,
    expectedProviderSequence: input.expectedProviderSequence,
    ...(hasSourceRevision ? { sourceRevision: input.expectedSourceRevision } : {}),
    state: input.action === 'pause' ? 'paused' : 'active', model,
    ...(input.action === 'pause' ? { reason: 'Paused by an administrator' } : {}),
  };
  return providerBindingSchema.parse(payload);
}

async function checkBinding(current: Inventory, input: BindingInput, providerId: string,
  binding: Binding, memberId: string) {
  const target = current.providers.get(providerId);
  const previous = bindingChoice(current, input);
  if (current.position !== input.expectedProviderSequence ||
    target?.revision !== input.expectedRevision ||
    (previous?.position ?? 0) !== input.expectedBindingSequence) {
    throw new ProviderConflict();
  }
  if (previous && previous.providerId !== providerId) {
    // Check permission on the old connection as well because the move takes its default away.
    await checkSource(current, previous, input.expectedSourceRevision, binding, memberId);
  }
  if (input.action === 'pause') {
    if (target.retired) {
      throw new ProviderRefused();
    }
    if (!previous || previous.providerId !== providerId) {
      throw new ProviderConflict();
    }
  } else {
    requireOwnedKey(current, providerId, binding.silo);
    // Let automatic setup keep using the first reachable connection without a paid test.
    const needsAnswer = input.kind === 'silo_default' &&
      input.commandId !== automaticDefaultCommandId;
    requireSelectable(target, input.model, needsAnswer);
  }
  return previous;
}

async function checkSource(current: Inventory, previous: Choice, revision: number | undefined,
  binding: Binding, memberId: string) {
  const rows = connectionRows(current.rows, previous.providerId);
  await providerPermission(binding, memberId, rows);
  const source = current.providers.get(previous.providerId);
  if (source?.revision !== revision) {
    throw new ProviderConflict();
  }
}

function requireOwnedKey(current: Inventory, providerId: string, silo: string) {
  function isKey(row: StoredEvent) {
    return row.event.type === 'provider.key_saved';
  }
  const rows = connectionRows(current.rows, providerId);
  const key = rows.findLast(isKey);
  // Keep provider keys in the silo that owns this choice.
  if (!key?.event.commandId || current.providers.get(providerId)?.secretRef !==
    providerSecretRef(silo, providerId, key.event.commandId)) {
    throw new ProviderChoiceRefused('connection_not_ready');
  }
}

function isAssistantCreation(row: StoredEvent) {
  return row.event.type === 'assistant.created';
}

export async function checkedHistory(store: EventStore, silo: string, subject: string, deadline: number) {
  const position = await store.head(subject, deadline);
  const rows = await history(store, subject, silo, deadline);
  if ((rows.at(-1)?.sequence ?? 0) !== position ||
    await store.head(subject, deadline) !== position) {
    throw new Error('History changed');
  }
  return rows;
}

export async function providerCreation(store: EventStore, silo: string, providerId: string) {
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
    chatDefault: chatDefaultPosition(current, binding.silo, providerId),
    routines: { status: routines.status, position: routines.position },
  };
}

function chatDefaultPosition(current: Inventory, silo: string, providerId: string) {
  const identity = chatDefaultIdentity(silo);
  const choice = bindingChoice(current, identity);
  if (!choice) {
    return null;
  }
  if (choice.providerId === providerId) {
    return { position: choice.position };
  }
  const source = current.providers.get(choice.providerId);
  return { position: choice.position, sourceRevision: source?.revision };
}

export function providerDefaultHandler(store: EventStore, binding: Binding) {
  async function recordDefault(trigger: EventEnvelope) {
    if (trigger.silo !== binding.silo) {
      throw new ProviderRefused();
    }
    const current = await inventory(store, binding.silo);
    if (trigger.type === 'provider.models_selected') {
      function isTrigger(row: StoredEvent) {
        return row.event.id === trigger.id;
      }
      // Retry when the selection has not reached this read yet. Returning would mark
      // the handler complete without saving the default choice.
      if (!current.rows.some(isTrigger)) {
        throw new Error('Provider selection unavailable');
      }
    }
    const choice = chatDefaultIdentity(binding.silo);
    // Keep any recorded choice, including a pause, when the setup event arrives again.
    if (bindingChoice(current, choice) || !current.firstVerified) {
      return;
    }
    const target = current.providers.get(current.firstVerified);
    const model = modelForTask('chat_turn');
    if (target?.retired || !target?.enabledModels.includes(model)) {
      return;
    }
    const actorSchema = z.object({ changedBy: providerIdSchema });
    const changedBy = actorSchema.parse(trigger.data).changedBy;
    // Reserve an id containing a colon, which user provider commands cannot supply.
    const command: BindingInput = {
      ...choice, commandId: automaticDefaultCommandId,
      expectedProviderSequence: current.position, expectedRevision: target.revision,
      expectedBindingSequence: 0, action: 'select', model,
    };
    await recordBinding(store, binding, changedBy, target.providerId, command);
  }
  return registerHandler('seed-provider-default', recordDefault);
}
