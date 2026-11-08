import { z } from 'zod';
import { childResultPublishedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { AuditRecord } from '@opencrane/protocol';
import { safeAuditId } from './audit-links.ts';

export function publicationAuditData(event: EventEnvelope): Record<string, unknown> {
  const parsed = childResultPublishedDataSchema.safeParse(event.data);
  if (!parsed.success || event.source !== 'opencrane-server' ||
      event.subject !== `conversation-${parsed.data.conversationId}` ||
      event.principal?.kind !== 'human' ||
      event.principal.id !== parsed.data.publishedBy) {
    // Keep rejected private text out of projection errors.
    throw new Error('Invalid publication audit event');
  }
  return parsed.data;
}

export function publicationMetadata(event: EventEnvelope,
  data: Record<string, unknown>): Partial<AuditRecord> {
  if (event.type !== 'conversation.child_result_published') return {};
  return {
    parentConversationId: safeAuditId(data['conversationId']),
    childConversationId: safeAuditId(data['childConversationId']),
    resultEventId: safeAuditId(data['resultEventId']),
    publicationKind: z.enum(['final', 'interim']).parse(data['publicationKind']),
  };
}
