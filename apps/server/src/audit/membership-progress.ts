import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { AuditRecord } from '@opencrane/protocol';
import { readAuditOwnershipConfirmation, type Query } from '@opencrane/projections';

const operations = new Set(['remove', 'role_change', 'transfer_intent', 'appointment',
  'ownership_confirmation', 'step_down']);

/** Load exact owning receipts before the route makes its final access check. */
export async function readMembershipProgress(db: Query, binding: Binding, records: AuditRecord[]) {
  const auth = memberAuthorisation(binding);
  for (const record of records) {
    if (!record.operation || !operations.has(record.operation)) {
      continue;
    }
    const required = [record.eventId];
    let confirmed = true;
    if (record.operation === 'transfer_intent') {
      const confirmation = await readAuditOwnershipConfirmation(db, binding.silo, record);
      confirmed = confirmation !== undefined;
      if (confirmation) {
        required.push(confirmation.eventId);
      }
    }
    const receipts = await db.query<{ event_id: string }>(
      'SELECT event_id FROM projection_events WHERE projection = $1 AND event_id = ANY($2::text[])',
      ['members', required]);
    let readModel: 'current' | 'applying' = 'applying';
    if (confirmed && receipts.rows.length === required.length) {
      readModel = 'current';
    }
    let iamApplied = confirmed;
    for (const eventId of required) {
      const result = await auth.checkApplied(eventId);
      if (result.status === 'unavailable') {
        throw new Error('Membership progress unavailable');
      }
      iamApplied = iamApplied && result.allowed;
    }
    const iam = iamApplied ? 'current' : 'applying';
    record.progress = { readModel, iam, checkedAt: new Date().toISOString() };
  }
}
