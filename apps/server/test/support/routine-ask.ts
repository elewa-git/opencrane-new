import { getEventDefinition, toolApprovalRequestedDataSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';

/** Save credential-free evidence only; this fixture cannot qualify a company review. */
export async function routineAsk(store: EventStore, kind: string,
  changed: Record<string, unknown> = {}) {
  const approvalId = `ask-${kind}`;
  const subject = `approval-${approvalId}`;
  const example = getEventDefinition('tool.approval_requested')!.example;
  const request = toolApprovalRequestedDataSchema.parse(example);
  const fields = { ...request, approvalId, conversationId: 'routine-session-occurrence',
    turnId: 'routine-turn-occurrence', assistantId: 'sales-assistant', requesterId: 'alice',
    expiresAt: '2026-10-11T07:15:00.000Z', ...changed };
  const asked = envelope('test', subject, 'tool.approval_requested', fields, `request-${approvalId}`,
    new Date('2026-10-11T07:00:00Z'));
  await store.append({ event: asked, expectedSequence: 0 });
  let terminal = envelope('test', subject, 'approval.expired', { approvalId }, `ended-${approvalId}`,
    new Date(fields.expiresAt));
  if (kind !== 'Expired') {
    terminal = { ...terminal, type: 'approval.decided', source: 'opencrane-server',
      time: '2026-10-11T07:01:00.000Z', principal: { kind: 'human', id: 'alice' },
      data: { approvalId, decidedBy: 'alice', decision: 'rejected' } };
  }
  await store.append({ event: terminal, expectedSequence: await store.head(subject) });
  return { eventId: terminal.id, position: await store.head(subject) };
}
