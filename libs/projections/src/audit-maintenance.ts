import { memoryMaintenanceRecordedDataSchema, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { AuditRecord } from '@opencrane/protocol';
import { memoryScopeId } from './memory-keys.ts';
import type { Query } from './db.ts';

export function maintenanceAuditData(event: EventEnvelope): Record<string, unknown> {
  const parsed = memoryMaintenanceRecordedDataSchema.safeParse(event.data);
  if (!parsed.success || event.subject !== `scope-${parsed.data.scopeId}`) {
    throw new Error('Invalid maintenance audit event');
  }
  const data = parsed.data;
  if (data.scopeId !== memoryScopeId(event.silo, 'person', data.memberId)) {
    throw new Error('Invalid maintenance audit event');
  }
  const scheduler = event.source === 'opencrane-nightly' &&
    event.principal?.kind === 'system' && event.principal.id === 'nightly-memory';
  const preflight = event.source === 'opencrane-server' &&
    event.principal?.kind === 'system' && event.principal.id === 'opencrane-server';
  if (!scheduler && !preflight) {
    throw new Error('Invalid maintenance audit event');
  }
  if (data.action === 'prepared' && !preflight) {
    throw new Error('Invalid maintenance audit event');
  }
  return data;
}

export function maintenanceMetadata(data: Record<string, unknown>): Partial<AuditRecord> {
  const action = data['action'];
  if (action !== 'due' && action !== 'prepared' && action !== 'refused' &&
      action !== 'missed' && action !== 'no_changes') {
    throw new Error('Invalid maintenance audit event');
  }
  return {
    maintenanceAction: action,
    maintenanceScopeKind: 'person',
    maintenanceScopeId: String(data['scopeId']),
    maintenanceMemberId: String(data['memberId']),
    maintenanceNightId: String(data['nightId']),
    maintenanceRootId: typeof data['rootId'] === 'string' ? data['rootId'] : undefined,
    maintenanceAllowanceCents: action === 'prepared' ? 100 : undefined,
  };
}

export function maintenanceStatus(data: Record<string, unknown>): AuditRecord['status'] {
  if (data['action'] === 'due' || data['action'] === 'prepared') return 'unknown';
  if (data['action'] === 'refused' || data['action'] === 'missed') return 'not_dispatched';
  return 'recorded';
}

export async function maintenanceAnchor(db: Query, event: EventEnvelope,
  data: Record<string, unknown>): Promise<boolean> {
  const previous = await db.query<{ event_id: string; metadata: unknown }>(
    `SELECT event_id, metadata FROM audit_entries
      WHERE silo = $1 AND event_type = 'memory.maintenance_recorded'
        AND metadata->>'maintenanceScopeId' = $2
        AND metadata->>'maintenanceNightId' = $3
        AND event_id <> $4 AND anchor = TRUE
      ORDER BY position DESC LIMIT 1`,
    [event.silo, data['scopeId'], data['nightId'], event.id]);
  const current = previous.rows[0];
  if (!current) return true;
  const record = z.object({ maintenanceAction: z.string() }).parse(current.metadata);
  if (record.maintenanceAction !== 'due' || data['action'] === 'due') return false;
  // Replace a pending intent with its observed result for this exact night.
  await db.query('UPDATE audit_entries SET anchor = FALSE WHERE silo = $1 AND event_id = $2',
    [event.silo, current.event_id]);
  return true;
}
