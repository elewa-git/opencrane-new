import { type EventEnvelope, getEventDefinition, toolApprovalRequestedDataSchema,
  toolDispatchRecordedDataSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';

/** Save credential-free evidence only; this fixture cannot qualify a company review. */
export async function routineAsk(store: EventStore, kind: string,
  changed: Record<string, unknown> = {}, terminalChange: Partial<EventEnvelope> = {}) {
  const approvalId = `ask-${kind}`;
  const subject = `approval-${approvalId}`;
  const example = getEventDefinition('tool.approval_requested')!.example;
  const request = toolApprovalRequestedDataSchema.parse(example);
  const fields = { ...request, approvalId, conversationId: 'routine-session-occurrence',
    turnId: 'routine-turn-occurrence', assistantId: 'sales-assistant', requesterId: 'alice',
    expiresAt: '2026-10-11T07:15:00.000Z', ...changed };
  // Record the request just after the hold starts, as the Ask writer does.
  const asked = envelope('test', subject, 'tool.approval_requested', fields, `request-${approvalId}`,
    new Date('2026-10-11T07:00:00.005Z'));
  await store.append({ event: asked, expectedSequence: 0 });
  if (kind === 'Requested') {
    return { eventId: asked.id, position: await store.head(subject) };
  }
  if (kind === 'ExpiredApproved') {
    const approved = { ...asked, id: `approved-${approvalId}`, commandId: `approved-${approvalId}`,
      type: 'approval.decided', source: 'opencrane-server',
      principal: { kind: 'human' as const, id: 'alice' },
      data: { approvalId, decidedBy: 'alice', decision: 'approved' } };
    await store.append({ event: approved, expectedSequence: await store.head(subject) });
  }
  let terminal = envelope('test', subject, 'approval.expired', { approvalId }, `ended-${approvalId}`,
    new Date(fields.expiresAt));
  if (kind !== 'Expired' && kind !== 'ExpiredApproved') {
    terminal = { ...terminal, type: 'approval.decided', source: 'opencrane-server',
      time: '2026-10-11T07:01:00.000Z', principal: { kind: 'human', id: 'alice' },
      data: { approvalId, decidedBy: 'alice', decision: kind === 'Approved' ? 'approved' : 'rejected' } };
  }
  if (kind === 'DeniedLate') {
    terminal.time = '2026-10-11T07:15:00.001Z';
  }
  if (kind === 'Used') {
    terminal = { ...terminal, type: 'approval.used', data: { approvalId, permitId: 'used' } };
  }
  terminal = { ...terminal, ...terminalChange };
  await store.append({ event: terminal, expectedSequence: await store.head(subject) });
  return { eventId: terminal.id, position: await store.head(subject) };
}

export async function routineUsedAsk(store: EventStore, kind: string) {
  await routineAsk(store, 'Approved');
  const approvalId = 'ask-Approved';
  const subject = `approval-${approvalId}`;
  async function save(type: string, data: unknown, id: string, owner = false) {
    const event = envelope('test', subject, type, data, id,
      new Date('2026-10-11T07:02:00.000Z'));
    if (owner) {
      event.source = 'opencrane-server';
      event.principal = { kind: 'human', id: kind === 'foreign retry' ? 'bob' : 'alice' };
    }
    await store.append({ event, expectedSequence: await store.head(subject) });
    return { eventId: event.id, position: await store.head(subject) };
  }
  async function use(permitId: string) {
    const used = await save('approval.used', { approvalId, permitId }, `used-${permitId}`);
    const example = getEventDefinition('tool.dispatch_recorded')!.example;
    const dispatch = toolDispatchRecordedDataSchema.parse(example);
    const details = { ...dispatch, approvalId, requestId: permitId,
      conversationId: 'routine-session-occurrence', turnId: 'routine-turn-occurrence',
      serverId: 'mcp_1', toolName: 'odoo.write' };
    if (kind === 'foreign proof') {
      details.approvalId = 'another';
    }
    if (kind === 'uncertain') {
      details.evidence = 'transport_uncertain';
    }
    const decisionSubject = `decision-${permitId}`;
    const proof = envelope('test', decisionSubject, 'tool.dispatch_recorded', details,
      `dispatch-${permitId}`, new Date('2026-10-11T07:02:01.000Z'));
    if (kind !== 'missing proof') {
      await store.append({ event: proof, expectedSequence: 0 });
    }
    return used;
  }
  const used = await use('00000000-0000-4000-8000-000000000001');
  if (kind === 'used only') {
    return used;
  }
  if (['retry', 'retry used', 'foreign retry'].includes(kind)) {
    await save('approval.retry_requested', { approvalId }, 'retry', true);
  }
  if (kind === 'retry used') {
    await use('00000000-0000-4000-8000-000000000002');
  }
  const expired = envelope('test', subject, 'approval.expired', { approvalId }, 'expired',
    new Date('2026-10-11T07:15:00.000Z'));
  await store.append({ event: expired, expectedSequence: await store.head(subject) });
  return { eventId: expired.id, position: await store.head(subject) };
}
