import type { z } from 'zod';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import { assistantCreatedDataSchema, type connectionSelectedDataSchema } from '@opencrane/events';

export interface PersonalKeyConsent {
  userId: string;
  allowedAssistantIds?: string[] | undefined;
}

function emptyAssistantCreation(): StoredEvent[] {
  return [];
}

function addAssistantCreation(rows: StoredEvent[], row: StoredEvent) {
  if (rows.length === 0 && row.event.type === 'assistant.created') {
    rows.push(row);
  }
}

function copyAssistantCreation(rows: StoredEvent[]) {
  return rows.slice();
}

const assistantCreation: SummaryKind<StoredEvent[]> = {
  name: 'personal-key-assistant-creation',
  keep: 64,
  empty: emptyAssistantCreation,
  add: addAssistantCreation,
};

/** Keep the first creation event; later settings cannot change legacy key consent. */
export function readPersonalKeyAssistant(store: EventStore, silo: string,
  assistantId: string, deadline: number) {
  return readStreamSummary(store, silo, `assistant-${assistantId}`,
    assistantCreation, deadline, copyAssistantCreation);
}

/** Interpret older choices without changing their saved events. */
export function assistantMayUsePersonalKey(choice: PersonalKeyConsent,
  assistantId: string, rows: StoredEvent[]) {
  if (choice.allowedAssistantIds !== undefined) {
    return choice.allowedAssistantIds.includes(assistantId);
  }
  for (const row of rows) {
    if (row.event.type !== 'assistant.created') {
      continue;
    }
    const created = assistantCreatedDataSchema.safeParse(row.event.data);
    return created.success && created.data.assistantId === assistantId &&
      created.data.kind === 'personal' && created.data.ownerId === choice.userId;
  }
  return false;
}

export function savedAssistantConsent(choice: z.infer<typeof connectionSelectedDataSchema> | null) {
  if (choice?.action === 'select' && choice.ownerKind !== 'company' &&
      choice.allowedAssistantIds !== undefined) {
    return { allowedAssistantIds: choice.allowedAssistantIds };
  }
  return {};
}
