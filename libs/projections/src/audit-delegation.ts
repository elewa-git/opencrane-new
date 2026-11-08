import { createHash } from 'node:crypto';
import { z } from 'zod';
import { delegationStartedDataSchema, delegationCompletedDataSchema,
  parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { AuditRecord } from '@opencrane/protocol';
import type { Query } from './db.ts';
import { safeAuditId } from './audit-links.ts';

const startSchema = z.object({
  delegationId: z.string(), rootId: z.string(), assistantId: z.string(),
  generation: z.int().positive(), conversationId: z.string(),
  parentDelegationId: z.string().optional(),
}).strict();
type Start = z.infer<typeof startSchema>;
type SavedStart = Start & { eventId: string; position: number };

function delegationStartMetadata(data: Record<string, unknown>): Start {
  const start = delegationStartedDataSchema.parse(data);
  if (!('version' in start)) throw new Error('Modern delegation required');
  return startSchema.parse({ delegationId: start.delegationId, rootId: start.rootId,
    assistantId: start.assistantId, generation: start.generation,
    conversationId: start.conversationId, parentDelegationId: start.parentDelegationId });
}

export async function createDelegationAuditIndexes(db: Query): Promise<void> {
  await db.query('ALTER TABLE audit_entries ADD COLUMN IF NOT EXISTS public_id TEXT');
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS audit_public_id ON audit_entries (silo, public_id)');
  await db.query(`CREATE INDEX IF NOT EXISTS audit_delegation_start
    ON audit_entries (silo, (metadata->>'delegationId'), position)
    WHERE event_type = 'delegation.started'`);
}

export async function saveDelegationStart(db: Query, event: EventEnvelope,
  data: Record<string, unknown>, position: number): Promise<void> {
  const start = delegationStartMetadata(data);
  await db.query(`INSERT INTO audit_entries
    (silo,event_id,position,anchor,metadata,recorded_at,event_type,public_id)
    VALUES ($1,$2,$3,FALSE,$4,$5,$6,$7) ON CONFLICT (silo,event_id) DO NOTHING`,
  [event.silo, event.id, position, JSON.stringify(start), event.time, event.type,
    delegationPublicId(event.id)]);
}

export function delegationPublicId(eventId: string): string {
  return createHash('sha256').update(eventId).digest('hex');
}

export function modernDelegationData(event: EventEnvelope): Record<string, unknown> | undefined {
  if (event.type !== 'delegation.started' && event.type !== 'delegation.completed') return;
  const parsed = parseEventByType(event);
  if (!parsed.success) {
    throw new Error('Invalid delegation audit event');
  }
  const data = event.type === 'delegation.started'
    ? delegationStartedDataSchema.parse(event.data)
    : delegationCompletedDataSchema.parse(event.data);
  if (!('version' in data)) return;
  if (event.source !== 'opencrane-server' || event.principal?.kind !== 'system' ||
      event.principal.id !== 'opencrane-server' ||
      event.subject !== `delegation-${data.delegationId}`) {
    throw new Error('Invalid delegation audit event');
  }
  return data;
}

async function savedStart(db: Query, silo: string,
  delegationId: string): Promise<SavedStart | undefined> {
  const result = await db.query<{ metadata: unknown; event_id: string; position: string | number }>(
    `SELECT metadata, event_id, position FROM audit_entries
      WHERE silo = $1 AND event_type = 'delegation.started'
      AND metadata->>'delegationId' = $2 ORDER BY position LIMIT 1`, [silo, delegationId]);
  const data = startSchema.safeParse(result.rows[0]?.metadata);
  if (!data.success) return;
  const row = result.rows[0]!;
  return { ...data.data, eventId: row.event_id, position: Number(row.position) };
}

export async function delegationMetadata(db: Query, event: EventEnvelope,
  data: Record<string, unknown>): Promise<Partial<AuditRecord>> {
  if (event.type === 'delegation.started') return {};
  if (event.type !== 'delegation.completed') return {};
  const outcome = delegationCompletedDataSchema.parse(data);
  if (!('version' in outcome)) return {};
  const start = await savedStart(db, event.silo, outcome.delegationId);
  const base: Partial<AuditRecord> = { executionOutcome: outcome.outcome,
    executionReason: outcome.reason,
    moneyStatus: 'unavailable', effectStatus: 'unavailable', joinStatus: 'unavailable',
    terminalEventId: safeAuditId(outcome.terminalEvidence.eventId),
    terminalPosition: outcome.terminalEvidence.position };
  if (!start) return base;
  const parent = start.parentDelegationId
    ? await savedStart(db, event.silo, start.parentDelegationId) : undefined;
  if (start.parentDelegationId && (!parent || parent.rootId !== start.rootId ||
      parent.assistantId !== start.assistantId || parent.generation !== start.generation)) {
    return base;
  }
  return { ...base, delegationId: safeAuditId(start.delegationId),
    startEventId: safeAuditId(start.eventId), startPosition: start.position,
    parentDelegationId: safeAuditId(start.parentDelegationId), rootId: safeAuditId(start.rootId),
    assistantId: safeAuditId(start.assistantId), delegationGeneration: start.generation,
    childConversationId: safeAuditId(start.conversationId),
    parentConversationId: safeAuditId(parent?.conversationId), joinStatus: 'current' };
}
