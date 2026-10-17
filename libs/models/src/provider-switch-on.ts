import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { computerTurnStartedDataSchema, computerTurnClosedDataSchema,
  providerBindingSchema, providerDrainSchema, providerIdSchema, parseEventByType,
  type EventEnvelope } from '@opencrane/events';
import { readEventAt, readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import { applyProvider, type ProviderState } from '@opencrane/projections';
import { data, models } from './state.ts';
import { ProviderConflict, ProviderRefused, providerAuthority, providerPermission,
  providerReceipt, reconcileProvider } from './providers.ts';

const inputSchema = z.object({
  commandId: providerIdSchema, expectedRevision: z.int().positive(),
  expectedProviderSequence: z.int().nonnegative(), expectedDrainSequence: z.int().nonnegative(),
}).strict();
type Choice = z.infer<typeof providerBindingSchema> & { automatic: boolean };
type Configuration = {
  providers: Map<string, ProviderState>; creations: Map<string, StoredEvent>; ids: Set<string>;
  choices: Map<string, Choice>; draining: boolean; drainSequence: number;
};
function emptyConfiguration(): Configuration {
  return { providers: new Map(), creations: new Map(), ids: new Set(), choices: new Map(),
    draining: false, drainSequence: 0 };
}
function addConfiguration(summary: Configuration, row: StoredEvent) {
  const event = row.event;
  const changeIdentity = JSON.stringify([event.subject, event.commandId]);
  summary.ids.add(changeIdentity);
  const providerId = event.subject.slice('provider-'.length);
  const state = applyProvider(summary.providers.get(providerId), event, row.sequence);
  summary.providers.set(providerId, state);
  if (event.type === 'provider.created') {
    summary.creations.set(providerId, row);
  }
  if (event.type === 'provider.managed_calls_drain_set') {
    summary.draining = providerDrainSchema.parse(event.data).draining;
    summary.drainSequence = row.sequence;
  }
  if (event.type === 'provider.model_binding_set') {
    const data = providerBindingSchema.parse(event.data);
    const identity = JSON.stringify([data.kind, data.dependantId]);
    const choice = { ...data, automatic: event.commandId === 'system:seed-provider-default' };
    summary.choices.set(identity, choice);
  }
}
const configuration: SummaryKind<Configuration> = {
  name: 'provider-switch-configuration', keep: 4, empty: emptyConfiguration, add: addConfiguration,
};
type Legacy = Map<string, Map<string, boolean>>;
function emptyLegacy(): Legacy {
  return new Map();
}
function addLegacy(summary: Legacy, row: StoredEvent) {
  const event = row.event;
  let turns = summary.get(event.subject);
  if (!turns) {
    turns = new Map();
    summary.set(event.subject, turns);
  }
  if (['computer.lost', 'computer.retired', 'computer.claimed'].includes(event.type)) {
    for (const turnId of turns.keys()) {
      turns.set(turnId, false);
    }
  }
  if (event.type === 'computer.turn_closed') {
    turns.set(computerTurnClosedDataSchema.parse(event.data).turnId, false);
  }
  if (event.type === 'computer.turn_started') {
    const data = computerTurnStartedDataSchema.parse(event.data);
    // Keep a close terminal even if an old start arrives after it.
    if (data.task === 'chat_turn' && !data.providerId && !turns.has(data.turnId)) {
      turns.set(data.turnId, true);
    }
  }
}
function hasLegacy(summary: Legacy) {
  for (const turns of summary.values()) {
    for (const active of turns.values()) {
      if (active) {
        return true;
      }
    }
  }
  return false;
}
const legacy: SummaryKind<Legacy> = {
  name: 'provider-switch-legacy', keep: 4, empty: emptyLegacy, add: addLegacy,
};
type Budget = {
  marker?: StoredEvent; ids: Set<string>; reservations: Set<string>; dispatches: Set<string>;
};
function emptyBudget(): Budget {
  return { ids: new Set(), reservations: new Set(), dispatches: new Set() };
}
function addBudget(summary: Budget, row: StoredEvent) {
  if (row.event.commandId) {
    summary.ids.add(row.event.commandId);
  }
  if (row.event.type === 'provider.managed_calls_enabled') {
    summary.marker = row;
  }
  const parsed = parseEventByType(row.event);
  if (!parsed.success) {
    throw new Error('Invalid spending event');
  }
  const event = parsed.event;
  const payload = data(event);
  if (event.type === 'budget.reserved') {
    summary.reservations.add(z.string().parse(payload['reservationId']));
  }
  if (event.type === 'budget.call_dispatch_admitted') {
    const reservationId = z.string().optional().parse(payload['reservationId']);
    const callId = z.string().parse(payload['callId']);
    summary.dispatches.add(reservationId ?? callId);
  }
  // Keep expired holds and unknown outcomes open even after their computer or turn ends.
  if (event.type === 'budget.settled') {
    const reservationId = z.string().parse(payload['reservationId']);
    if (payload['outcome'] === 'unknown') {
      summary.reservations.add(reservationId);
    } else {
      summary.reservations.delete(reservationId);
      summary.dispatches.delete(reservationId);
    }
  }
}
const budget: SummaryKind<Budget> = {
  name: 'provider-switch-budget', keep: 4, empty: emptyBudget, add: addBudget,
};
function requireSettledSpending(openSpending: boolean) {
  if (openSpending) {
    throw new ProviderRefused();
  }
}
function takeMarker(summary: Budget) {
  return structuredClone(summary.marker);
}
export async function providerSwitchOnChange(store: EventStore, silo: string,
  providerId: string, commandId: string, deadline: number) {
  const marker = await readStreamSummary(store, silo, `budget-${silo}`, budget, deadline, takeMarker);
  if (marker?.event.commandId === commandId && providerReceipt(marker).providerId === providerId) {
    return marker;
  }
  return undefined;
}
function takeConfiguration(summary: Configuration, sequence: number) {
  return { ...structuredClone(summary), sequence };
}
function validChoices(current: Configuration, silo: string, providerId: string) {
  const fallback = current.choices.get(JSON.stringify(['silo_default', silo]));
  if (!fallback || fallback.state !== 'active' || fallback.providerId !== providerId ||
    fallback.automatic) {
    return false;
  }
  for (const choice of current.choices.values()) {
    if (choice.state === 'paused') {
      continue;
    }
    const connection = current.providers.get(choice.providerId);
    function supported(model: (typeof models)[number]) {
      return model.id === choice.model && !model.retired;
    }
    if (!connection || connection.provider !== 'openai' || !connection.saved ||
      !connection.secretRef || !connection.lastReachable ||
      !connection.enabledModels.includes(choice.model) || !models.some(supported)) {
      return false;
    }
  }
  return true;
}
function requirePositions(current: Configuration & { sequence: number },
  input: z.infer<typeof inputSchema>, providerId: string) {
  if (current.sequence !== input.expectedProviderSequence ||
    current.drainSequence !== input.expectedDrainSequence ||
    current.providers.get(providerId)?.revision !== input.expectedRevision) {
    throw new ProviderConflict();
  }
}

export async function providerSwitchOn(store: EventStore, binding: Binding,
  memberId: string, providerId: string, raw: unknown) {
  providerIdSchema.parse(providerId);
  const input = inputSchema.parse(raw);
  const deadline = performance.now() + 10_000;
  // Capture all activity before history reads. Any later event refuses this migration append.
  const globalSequence = await store.head(undefined, deadline);
  const current = await readStreamSummary(store, binding.silo, 'provider-*',
    configuration, deadline, takeConfiguration);
  function takeBudget(summary: Budget, sequence: number) {
    return { marker: structuredClone(summary.marker), sequence,
      duplicate: summary.ids.has(input.commandId),
      openSpending: summary.reservations.size > 0 || summary.dispatches.size > 0 };
  }
  const spending = await readStreamSummary(store, binding.silo, `budget-${binding.silo}`,
    budget, deadline, takeBudget);
  const activeLegacy = await readStreamSummary(store, binding.silo, 'computer-*',
    legacy, deadline, hasLegacy);
  const identity = JSON.stringify([`provider-${providerId}`, input.commandId]);
  const providerCommandExists = current.ids.has(identity);
  const choicesValid = validChoices(current, binding.silo, providerId);
  const fresh = await providerAuthority(store, binding, memberId);
  const created = current.creations.get(providerId);
  await providerPermission(binding, memberId, created ? [created] : []);
  const data = { providerId, revision: input.expectedRevision, changedBy: memberId,
    expectedProviderSequence: input.expectedProviderSequence };
  const event: EventEnvelope = {
    id: randomUUID(), commandId: input.commandId, subject: `budget-${binding.silo}`,
    silo: binding.silo, type: 'provider.managed_calls_enabled', data,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human', id: memberId },
  };
  if (await store.head(undefined, fresh.deadline) !== globalSequence) {
    throw new ProviderConflict();
  }
  if (spending.duplicate) {
    if (!spending.marker || current.drainSequence !== input.expectedDrainSequence) {
      throw new ProviderConflict();
    }
    reconcileProvider(spending.marker, event);
    // Recheck holds reopened by late evidence, even when the original reply was lost.
    requireSettledSpending(spending.openSpending);
    await fresh();
    return providerReceipt(spending.marker);
  }
  if (providerCommandExists) {
    throw new ProviderConflict();
  }
  if (spending.marker || !current.draining || activeLegacy) {
    throw new ProviderRefused();
  }
  requireSettledSpending(spending.openSpending);
  requirePositions(current, input, providerId);
  if (!choicesValid) {
    throw new ProviderRefused();
  }
  const command = { event, expectedSequence: spending.sequence,
    expectedGlobalSequence: globalSequence, historyChecked: true as const, deadline: fresh.deadline };
  await fresh();
  const result = await store.append(command);
  if (result.status === 'conflict') {
    throw new ProviderConflict();
  }
  if (result.status !== 'appended') {
    throw new Error('Switch-on append unavailable');
  }
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) {
    throw new Error('Saved switch-on unavailable');
  }
  reconcileProvider(saved, event);
  return providerReceipt(saved);
}
