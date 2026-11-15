import type { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { assistantCreatedDataSchema, type connectionSelectedDataSchema } from '@opencrane/events';

export interface PersonalKeyConsent {
  userId: string;
  allowedAssistantIds?: string[] | undefined;
}

/** Interpret older choices without changing their saved events. */
export function assistantMayUsePersonalKey(choice: PersonalKeyConsent,
  assistantId: string, rows: StoredEvent[]) {
  if (choice.allowedAssistantIds !== undefined) {
    return choice.allowedAssistantIds.includes(assistantId);
  }
  for (const row of rows) {
    if (row.event.type !== 'assistant.created') continue;
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
