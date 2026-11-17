import { z } from 'zod';
import { toolApprovalRequestedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { ApprovalCard } from '@opencrane/protocol';
import { history } from './event-history.ts';
import { approvalGrantRevoked, approvalPolicyChange, approvalTakenOver }
  from './approval-cancellation.ts';

export type ApprovalConversationSnapshot = {
  conversationRows?: StoredEvent[] | undefined;
  conversationPosition?: number | undefined;
};

export type ApprovalInvalidationRead = {
  request: z.infer<typeof toolApprovalRequestedDataSchema>;
  requestPosition: number;
  deadline: number;
  snapshot: ApprovalConversationSnapshot;
};

export function invalidatesApproval(event: EventEnvelope, turnId: string) {
  if (['conversation.closed', 'message.posted', 'agent.turn_started'].includes(event.type)) {
    return true;
  }
  return closesDecisionTurn(event, turnId);
}

export function closesDecisionTurn(event: EventEnvelope, turnId: string) {
  const closesTurn = [
    'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  ].includes(event.type);
  return closesTurn && z.object({ turnId: z.string() }).parse(event.data).turnId === turnId;
}

export async function approvalInvalidation(store: EventStore, silo: string,
  read: ApprovalInvalidationRead) {
  const { request, requestPosition, deadline, snapshot } = read;
  if (await approvalTakenOver(store, silo, request, requestPosition, deadline)) {
    return { closed: true, conversationPosition: 0, cancelReason: 'takeover' as const };
  }
  const rows = snapshot.conversationRows ?? await history(
    store, `conversation-${request.conversationId}`, silo, deadline);
  function startsBoundTurn(row: StoredEvent) {
    return row.event.type === 'agent.turn_started' &&
      z.object({ turnId: z.string() }).parse(row.event.data).turnId === request.turnId;
  }
  function invalidatesBoundApproval(row: StoredEvent) {
    return invalidatesApproval(row.event, request.turnId);
  }
  const start = rows.findIndex(startsBoundTurn);
  const later = rows.slice(start + 1);
  const conversationPosition = snapshot.conversationPosition ?? rows.at(-1)?.sequence ?? 0;
  if (start < 0) return { closed: true, conversationPosition };
  const invalidating = later.find(invalidatesBoundApproval);
  if (invalidating) {
    const cancelReason = turnCancellationReason(invalidating.event.type);
    return { closed: true, conversationPosition, cancelReason };
  }
  if (await approvalGrantRevoked(store, silo, request, requestPosition, deadline)) {
    return { closed: true, conversationPosition, cancelReason: 'grant_revoked' as const };
  }
  const policy = await approvalPolicyChange(store, silo, request, deadline);
  return { ...policy, conversationPosition };
}

function turnCancellationReason(type: string): ApprovalCard['cancelReason'] {
  if (type === 'conversation.closed') return 'conversation_closed';
  if (type === 'message.posted') return 'new_message';
  if (type === 'agent.turn_started') return 'new_turn';
  if (type === 'agent.turn_stop_requested') return 'turn_stopped';
  return 'turn_ended';
}
