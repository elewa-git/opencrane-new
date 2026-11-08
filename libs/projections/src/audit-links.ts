import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';

export const auditIdentifier = z.string().regex(/^[\w:.-]{1,300}$/u);

export function safeAuditId(value: unknown): string | undefined {
  return auditIdentifier.safeParse(value).data;
}

function firstId(...values: unknown[]): string | undefined {
  const selected = values.find(value => value !== undefined);
  return safeAuditId(selected);
}

export function isDispatchEvent(type: string): boolean {
  return type === 'tool.dispatch_started' || type === 'tool.dispatch_recorded';
}

export function auditLinks(event: EventEnvelope, data: Record<string, unknown>) {
  if (event.type === 'conversation.child_result_published') {
    // Use only the reviewed publication payload; envelope links may name private work.
    return { request: undefined, permit: undefined, approval: undefined,
      conversationId: safeAuditId(data['conversationId']), turnId: safeAuditId(data['turnId']),
      requesterId: undefined };
  }
  const call = z.record(z.string(), z.unknown()).safeParse(data['modelCall']).data ?? {};
  const request = firstId(data['requestId'], call['requestId'], event.correlation.request);
  // Bind dispatch evidence to its saved request, never another attempt's correlation.
  const permit = isDispatchEvent(event.type) ? undefined :
    firstId(data['permitId'], event.correlation.permit);
  const approval = firstId(data['approvalId'], event.correlation.approval);
  const conversationId = firstId(data['conversationId'], call['conversationId'],
    event.correlation.conversation);
  const turnId = firstId(data['turnId'], call['turnId'], event.correlation.turn);
  const requesterId = firstId(data['requesterId'], call['requesterId'], data['requestedBy']);
  return { request, permit, approval, conversationId, turnId, requesterId };
}
