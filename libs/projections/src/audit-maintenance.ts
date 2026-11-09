import { memoryMaintenanceRecordedDataSchema, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { AuditRecord } from '@opencrane/protocol';
import { memoryScopeId } from './memory-keys.ts';
import type { Query } from './db.ts';

function maintenanceSource(event: EventEnvelope): 'scheduler' | 'preflight' | null {
  if (event.principal?.kind !== 'system') return null;
  if (event.source === 'opencrane-nightly' && event.principal.id === 'nightly-memory') {
    return 'scheduler';
  }
  if (event.source === 'opencrane-server' && event.principal.id === 'opencrane-server') {
    return 'preflight';
  }
  return null;
}

export function maintenanceAuditData(event: EventEnvelope): Record<string, unknown> | undefined {
  const parsed = memoryMaintenanceRecordedDataSchema.safeParse(event.data);
  if (!parsed.success || event.subject !== `scope-${parsed.data.scopeId}`) {
    throw new Error('Invalid maintenance audit event');
  }
  const data = parsed.data;
  if (data.scopeKind !== 'person') {
    // Leave shared scopes out of the personal audit view without blocking later events.
    return undefined;
  }
  if (data.scopeId !== memoryScopeId(event.silo, 'person', data.memberId)) {
    throw new Error('Invalid maintenance audit event');
  }
  const source = maintenanceSource(event);
  if (!source) {
    throw new Error('Invalid maintenance audit event');
  }
  if (data.action === 'prepared' && source !== 'preflight') {
    throw new Error('Invalid maintenance audit event');
  }
  // Older receipts have no saved random reference. Their night id is predictable.
  if (!data.publicReference) return undefined;
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
    maintenanceReference: String(data['publicReference']),
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
        AND metadata->>'maintenanceReference' = $3
        AND event_id <> $4 AND anchor = TRUE
      ORDER BY position DESC LIMIT 1`,
    [event.silo, data['scopeId'], data['publicReference'], event.id]);
  const current = previous.rows[0];
  if (!current) return true;
  const record = z.object({ maintenanceAction: z.string() }).parse(current.metadata);
  if (record.maintenanceAction !== 'due' || data['action'] === 'due') return false;
  // Replace a pending intent with its observed result for this exact night.
  await db.query(`UPDATE audit_entries SET anchor = FALSE, public_id = NULL
    WHERE silo = $1 AND event_id = $2`,
    [event.silo, current.event_id]);
  return true;
}
