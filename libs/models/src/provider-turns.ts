import { providerBindingSchema } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';

type Choice = { providerId: string; bindingSequence: number; model: string; state: 'active' | 'paused' };
type Routing = { enabled: boolean; choices: Map<string, Choice> };

function choiceKey(kind: string, dependantId: string) {
  return JSON.stringify([kind, dependantId, 'chat_turn']);
}

function emptyRouting(): Routing {
  return { enabled: false, choices: new Map() };
}

function addRouting(summary: Routing, row: StoredEvent) {
  if (row.event.type === 'provider.managed_calls_enabled') {
    // Keep switch-on even if the default later moves to another connection.
    summary.enabled = true;
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

function takeEnabled(summary: Routing) {
  return summary.enabled;
}

export function managedProviderCallsEnabled(store: EventStore, silo: string, deadline: number) {
  return readStreamSummary(store, silo, 'provider-*', providerRouting, deadline, takeEnabled);
}

export async function providerTurnAdmission(store: EventStore, silo: string,
  assistantId: string, deadline: number) {
  function takeAdmission(summary: Routing) {
    const own = summary.choices.get(choiceKey('assistant', assistantId));
    const fallback = summary.choices.get(choiceKey('silo_default', silo));
    const choice = own ?? fallback;
    return { enabled: summary.enabled, choice };
  }
  const admission = await readStreamSummary(
    store, silo, 'provider-*', providerRouting, deadline, takeAdmission);
  return admission;
}
