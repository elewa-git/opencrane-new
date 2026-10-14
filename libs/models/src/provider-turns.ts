import { applyBudget, budgetStopId, emptyBudget, type BudgetState } from './state.ts';
import { providerBindingSchema, providerDrainSchema } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';

type Choice = { providerId: string; bindingSequence: number; model: string; state: 'active' | 'paused' };
type Routing = { draining: boolean; choices: Map<string, Choice> };
type PersonalPayer = { position: number; payingGroupId: string };
type Mode = { enabled: boolean; budget: BudgetState; personalPayers: PersonalPayer[] };
type QueuedWork = { conversationId: string; turnId: string; position: number;
  payingGroupId?: string | undefined };

function choiceKey(kind: string, dependantId: string) {
  return JSON.stringify([kind, dependantId, 'chat_turn']);
}

function emptyRouting(): Routing {
  return { draining: false, choices: new Map() };
}

function addRouting(summary: Routing, row: StoredEvent) {
  if (row.event.type === 'provider.managed_calls_drain_set') {
    const data = providerDrainSchema.parse(row.event.data);
    summary.draining = data.draining;
  }
  if (row.event.type !== 'provider.model_binding_set') {
    return;
  }
  const data = providerBindingSchema.parse(row.event.data);
  const key = choiceKey(data.kind, data.dependantId);
  const choice = {
    providerId: data.providerId, bindingSequence: row.sequence, model: data.model, state: data.state,
  };
  summary.choices.set(key, choice);
}

const providerRouting: SummaryKind<Routing> = {
  name: 'provider-turn-routing', keep: 4, empty: emptyRouting, add: addRouting,
};

function emptyMode(): Mode {
  return { enabled: false, budget: emptyBudget(), personalPayers: [] };
}

function emptyEnabled() {
  return { enabled: false };
}
function addEnabled(summary: { enabled: boolean }, row: StoredEvent) {
  if (row.event.type === 'provider.managed_calls_enabled') {
    summary.enabled = true;
  }
}
function addMode(summary: Mode, row: StoredEvent) {
  addEnabled(summary, row);
  const previousPayer = summary.budget.defaultPayingGroupId;
  applyBudget(summary.budget, row.event, row.sequence);
  const payingGroupId = summary.budget.defaultPayingGroupId;
  if (payingGroupId !== undefined && payingGroupId !== previousPayer) {
    summary.personalPayers.push({ position: row.sequence, payingGroupId });
  }
}
// Keep status readable when older holds lack call details.
const providerEnabled: SummaryKind<{ enabled: boolean }> = {
  name: 'provider-enabled', keep: 4, empty: emptyEnabled, add: addEnabled,
};

const providerMode: SummaryKind<Mode> = {
  name: 'provider-call-mode', keep: 4, empty: emptyMode, add: addMode,
};

function takeEnabled(summary: { enabled: boolean }) {
  return summary.enabled;
}

export function managedProviderCallsEnabled(store: EventStore, silo: string, deadline: number) {
  // Read the silo's spending stream so legacy calls never scan provider connections.
  return readStreamSummary(store, silo, `budget-${silo}`, providerEnabled, deadline, takeEnabled);
}

function personalPayerBefore(summary: Mode, position: number) {
  function precedesWork(payer: PersonalPayer) {
    return payer.position < position;
  }
  const payer = summary.personalPayers.findLast(precedesWork);
  // Bind work queued before installation setup to the first configured payer.
  // Later changes must not move that work to another payer.
  return payer?.payingGroupId ?? summary.personalPayers[0]?.payingGroupId;
}

export function queuedPersonalPayer(store: EventStore, silo: string,
  position: number, deadline: number) {
  function takePayer(summary: Mode) {
    return personalPayerBefore(summary, position);
  }
  // Keep the message's payer through later default changes, including delayed stop delivery.
  return readStreamSummary(store, silo, `budget-${silo}`, providerMode, deadline, takePayer);
}

export async function providerTurnAdmission(store: EventStore, silo: string,
  assistantId: string, deadline: number, queued?: QueuedWork) {
  function takeBudgetAdmission(summary: Mode) {
    const defaultPayingGroupId = queued
      ? personalPayerBefore(summary, queued.position) : summary.budget.defaultPayingGroupId;
    let stopId: string | undefined;
    if (queued) {
      const work = { ...queued, assistantId,
        payingGroupId: queued.payingGroupId ?? defaultPayingGroupId };
      stopId = budgetStopId(summary.budget, work, new Date(), queued.position);
    }
    return { enabled: summary.enabled, defaultPayingGroupId, stopId };
  }
  function takeAdmission(summary: Routing) {
    const own = summary.choices.get(choiceKey('assistant', assistantId));
    const fallback = summary.choices.get(choiceKey('silo_default', silo));
    const choice = own ?? fallback;
    return { choice, draining: summary.draining };
  }
  // Fold payer and switch-on together so each new spending row is read only once.
  const budget = await readStreamSummary(
    store, silo, `budget-${silo}`, providerMode, deadline, takeBudgetAdmission);
  const admission = await readStreamSummary(
    store, silo, 'provider-*', providerRouting, deadline, takeAdmission);
  const draining = admission.draining && !budget.enabled;
  return { enabled: budget.enabled, defaultPayingGroupId: budget.defaultPayingGroupId,
    choice: admission.choice, draining, stopId: budget.stopId };
}
