import { approvalDecidedDataSchema, approvalCancelledDataSchema,
  approvalUsedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import type { ApprovalCard } from '@opencrane/protocol';

type RecordFields = Pick<ApprovalCard,
  'state' | 'requestedAt' | 'decidedAt' | 'usedAt' | 'endedAt' | 'cancelReason'>;

export function approvalRecord(rows: StoredEvent[]) {
  const record: RecordFields = { state: 'requested', requestedAt: rows[0]!.event.time };
  const uses: NonNullable<ApprovalCard['uses']> = [];
  let permitId: string | undefined;
  for (const { event } of rows.slice(1)) {
    if (event.type === 'approval.decided') {
      const { decision } = approvalDecidedDataSchema.parse(event.data);
      record.decidedAt ??= event.time;
      record.state = 'approved';
      if (decision === 'rejected') {
        record.state = 'denied';
        record.endedAt = event.time;
      }
    }
    if (event.type === 'approval.used') {
      permitId = approvalUsedDataSchema.parse(event.data).permitId;
      record.state = 'outcome_unknown';
      // Keep the first use visible when a later attempt gets another permit.
      record.usedAt ??= event.time;
      uses.push({ permitId, usedAt: event.time });
    }
    if (event.type === 'approval.retry_requested') record.state = 'approved';
    if (event.type === 'approval.expired' || event.type === 'approval.cancelled') {
      record.state = event.type === 'approval.expired' ? 'expired' : 'cancelled';
      record.endedAt = event.time;
      if (event.type === 'approval.cancelled') {
        const { cancelReason } = approvalCancelledDataSchema.parse(event.data);
        if (cancelReason) record.cancelReason = cancelReason;
      }
    }
  }
  return { ...record, uses, permitId };
}
