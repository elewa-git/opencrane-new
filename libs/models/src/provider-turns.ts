import { providerBindingSchema } from '@opencrane/events';
import { z } from 'zod';
import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';

type Choice = { providerId: string; bindingSequence: number; model: string; state: 'active' | 'paused' };
type Routing = { choices: Map<string, Choice> };
type Mode = { enabled: boolean; defaultPayingGroupId?: string };

const budgetDetails = z.object({
  scope: z.string(), defaultPayingGroupId: z.string().optional(),
});

function choiceKey(kind: string, dependantId: string) {
  return JSON.stringify([kind, dependantId, 'chat_turn']);
}

function emptyRouting(): Routing {
  return { choices: new Map() };
}

function addRouting(summary: Routing, row: StoredEvent) {
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
  return { enabled: false };
}

function addMode(summary: Mode, row: StoredEvent) {
  if (row.event.type === 'provider.managed_calls_enabled') {
    summary.enabled = true;
  }
  if (row.event.type === 'budget.ceiling_set') {
    const details = budgetDetails.parse(row.event.data);
    if (details.scope === 'global' && details.defaultPayingGroupId) {
      summary.defaultPayingGroupId = details.defaultPayingGroupId;
    }
  }
}

const providerMode: SummaryKind<Mode> = {
  name: 'provider-call-mode', keep: 4, empty: emptyMode, add: addMode,
};

function takeEnabled(summary: Mode) {
  return summary.enabled;
}

function takeBudgetAdmission(summary: Mode) {
  return { enabled: summary.enabled, defaultPayingGroupId: summary.defaultPayingGroupId };
}

export function managedProviderCallsEnabled(store: EventStore, silo: string, deadline: number) {
  // Read the silo's spending stream so legacy calls never scan provider connections.
  return readStreamSummary(store, silo, `budget-${silo}`, providerMode, deadline, takeEnabled);
}

export async function providerTurnAdmission(store: EventStore, silo: string,
  assistantId: string, deadline: number) {
  function takeAdmission(summary: Routing) {
    const own = summary.choices.get(choiceKey('assistant', assistantId));
    const fallback = summary.choices.get(choiceKey('silo_default', silo));
    const choice = own ?? fallback;
    return choice;
  }
  // Fold payer and switch-on together so each new spending row is read only once.
  const budget = await readStreamSummary(
    store, silo, `budget-${silo}`, providerMode, deadline, takeBudgetAdmission);
  const choice = await readStreamSummary(
    store, silo, 'provider-*', providerRouting, deadline, takeAdmission);
  return { enabled: budget.enabled, defaultPayingGroupId: budget.defaultPayingGroupId, choice };
}
