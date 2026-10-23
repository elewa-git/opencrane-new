import { readStreamSummary, wireSubject, WrongSiloError,
  type EventStore, type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  teamCreatedDataSchema } from '@opencrane/events';
import type { z } from 'zod';
import { MemberAccessRefused } from './member-authority.ts';

type ResourceFacts = {
  group?: z.infer<typeof teamCreatedDataSchema>;
  assistant?: z.infer<typeof assistantCreatedDataSchema>;
  active: boolean;
  personal: boolean;
  retired: boolean;
};
type ResourceChoice = { id: string; displayName: string; sequence: number };

function emptyResource(): ResourceFacts {
  return { active: true, personal: false, retired: false };
}

function addResource(facts: ResourceFacts, row: StoredEvent, subject: string, id: string) {
  const { event } = row;
  if (event.subject !== subject) throw new MemberAccessRefused('Spending choice unavailable');
  if (event.type === 'team.created') {
    const group = teamCreatedDataSchema.parse(event.data);
    if (group.teamId !== id) throw new MemberAccessRefused('Spending choice unavailable');
    facts.group = group;
  }
  if (event.type === 'assistant.created') {
    const assistant = assistantCreatedDataSchema.parse(event.data);
    if (assistant.assistantId !== id) throw new MemberAccessRefused('Spending choice unavailable');
    facts.assistant = assistant;
    if (assistant.kind === 'personal') facts.personal = true;
  }
  if (event.type === 'assistant.settings_changed') {
    const settings = assistantSettingsChangedDataSchema.parse(event.data);
    if (settings.assistantId !== id) throw new MemberAccessRefused('Spending choice unavailable');
    if (settings.active !== undefined) facts.active = settings.active;
  }
  // Keep retirement even if a later lifecycle record appears in the same stream.
  if (event.type === 'computer.retired') facts.retired = true;
}

function resourceSize(facts: ResourceFacts) {
  // Include variable-length saved names and ids in the retained memory allowance.
  return 512 + Buffer.byteLength(JSON.stringify(facts)) * 2;
}

async function readResource(store: EventStore, silo: string, category: string, id: string,
  deadline: number, positions: Map<string, number>) {
  const subject = `${category}-${id}`;
  wireSubject(subject);
  function add(facts: ResourceFacts, row: StoredEvent) {
    addResource(facts, row, subject, id);
  }
  function take(facts: ResourceFacts, sequence: number) {
    return { facts: structuredClone(facts), sequence };
  }
  const summary: SummaryKind<ResourceFacts> = {
    name: `budget-resource-${category}`, keep: 64, empty: emptyResource, add,
    budget: { limit: 2 * 1024 * 1024, size: resourceSize },
  };
  try {
    const result = await readStreamSummary(store, silo, subject, summary, deadline, take);
    const currentPosition = await store.head(subject, deadline);
    if (currentPosition < result.sequence) {
      throw new MemberAccessRefused('Spending choice unavailable');
    }
    positions.set(subject, result.sequence);
    return result;
  } catch (error) {
    if (error instanceof WrongSiloError) {
      throw new MemberAccessRefused('Spending choice unavailable');
    }
    throw error;
  }
}

export async function readBudgetResource(store: EventStore, silo: string,
  kind: 'paying_group' | 'assistant', id: string, deadline: number,
  positions = new Map<string, number>()): Promise<ResourceChoice | undefined> {
  if (kind === 'paying_group') {
    const resource = await readResource(store, silo, 'team', id, deadline, positions);
    if (!resource.facts.group) return undefined;
    return { id, displayName: resource.facts.group.name, sequence: resource.sequence };
  }
  const resource = await readResource(store, silo, 'assistant', id, deadline, positions);
  const { assistant, active, personal } = resource.facts;
  if (!assistant || personal || !active) return undefined;
  const computer = await readResource(store, silo, 'computer', id, deadline, positions);
  if (computer.facts.retired) return undefined;
  const group = await readBudgetResource(store, silo, 'paying_group', assistant.ownerId,
    deadline, positions);
  if (!group) return undefined;
  return { id, displayName: assistant.name ?? id, sequence: resource.sequence };
}
