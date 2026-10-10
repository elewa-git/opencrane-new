import type { EventStore } from '@opencrane/event-store';
import { ownershipConfirmedSchema, ownershipTransferredSchema } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { envelope, history } from './actor.ts';
import { currentMembership } from './ownership.ts';
import { ownershipWriteAccess } from './authority.ts';

export function ownershipConfirmationHandler(store: EventStore) {
  async function confirm(event: Parameters<ReturnType<typeof registerHandler>['handle']>[0]) {
    const transfer = ownershipTransferredSchema.parse(event.data);
    if (!transfer.awaitingConfirmation) return;
    const subject = `member-${transfer.memberId}`;
    const deadline = performance.now() + 10_000;
    const rows = await history(store, subject, event.silo, deadline);
    for (const row of rows) {
      if (row.event.type !== 'member.ownership_confirmed') continue;
      const saved = ownershipConfirmedSchema.parse(row.event.data);
      if (saved.appointmentId === event.id) return;
    }
    const membership = await currentMembership(store, event.silo, transfer.memberId,
      undefined, deadline);
    const recorded = membership.ownership.find(isRequest);
    function isRequest(row: (typeof rows)[number]) {
      return row.event.id === event.id;
    }
    if (!recorded || recorded.event.subject !== event.subject
      || ownershipTransferredSchema.parse(recorded.event.data).memberId !== transfer.memberId
      || ownershipTransferredSchema.parse(recorded.event.data).transferredBy !== transfer.transferredBy) {
      throw new Error('Confirmation requires a saved appointment');
    }
    if (!membership.role) return;
    const data = { memberId: transfer.memberId, appointmentId: event.id };
    const confirmation = envelope(event.silo, subject, 'member.ownership_confirmed', data,
      `confirm-${event.id}`);
    const positions = membership.positions;
    const fresh = await ownershipWriteAccess(store, positions);
    await fresh();
    const command = { event: confirmation, expectedSequence: rows.at(-1)?.sequence ?? 0,
      deadline: fresh.deadline, historyChecked: true as const };
    const result = await store.append(command);
    if (result.status !== 'appended') {
      throw new Error('Ownership confirmation will retry');
    }
  }
  return registerHandler('confirm-ownership', confirm);
}
