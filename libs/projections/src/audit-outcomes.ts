import type { AuditRecord, AuditRow } from '@opencrane/protocol';
import { auditResponseSchema } from '@opencrane/protocol';
import type { Query } from './db.ts';

export function maintenanceOutcome(record: AuditRecord): AuditRow['outcome'] {
  if (record.maintenanceAction === 'refused' || record.maintenanceAction === 'missed') {
    return 'not_dispatched';
  }
  if (record.maintenanceAction === 'no_changes') return 'recorded';
  return 'unknown';
}

function isRecordedDispatch(record: AuditRecord): boolean {
  return record.type === 'tool.dispatch_recorded';
}

function isDispatchStart(record: AuditRecord): boolean {
  return record.type === 'tool.dispatch_started';
}

function isSecurityAlert(record: AuditRecord): boolean {
  return record.type === 'security.alert_raised';
}

function isGatewayObservation(record: AuditRecord): boolean {
  return record.type === 'gateway.observation_recorded';
}

export function observedOutcome(decision: AuditRow['decision'], records: AuditRecord[],
  effect?: AuditRecord, settlement?: AuditRecord) {
  if (records.some(isSecurityAlert)) return 'unknown';
  const dispatch = records.findLast(isRecordedDispatch);
  // Keep transport evidence separate from business success and generic gateway observations.
  if (dispatch && decision === 'allow') return dispatch.status;
  // Keep a saved start without its outcome unknown, even after generic success.
  if (decision === 'allow' && records.some(isDispatchStart)) return 'unknown';
  if (effect && decision === 'allow') return effect.status;
  if (settlement?.status === 'not_dispatched' || ['ask', 'deny'].includes(decision)) {
    return 'not_dispatched';
  }
  if (decision === 'allow') return 'unknown';
  const gateway = records.findLast(isGatewayObservation);
  if (!gateway) return 'recorded';
  return gateway.status === 'unknown' ? 'unknown' : 'error';
}

/** Find only the confirmation of this appointment, without reading member history. */
export async function readAuditOwnershipConfirmation(db: Query, silo: string,
  intent: AuditRecord): Promise<AuditRecord | undefined> {
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_entries WHERE silo = $1
      AND event_type = 'member.ownership_confirmed' AND metadata->>'appointmentId' = $2
      AND metadata->>'memberId' = $3 AND position > $4 ORDER BY position LIMIT 2`,
    [silo, intent.eventId, intent.memberId, intent.position]);
  // Refuse to choose between conflicting confirmations.
  if (result.rows.length !== 1) return undefined;
  return auditResponseSchema.shape.rows.element.shape.records.element.parse(result.rows[0]!.metadata);
}
