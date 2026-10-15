import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { data, type BudgetState } from './state.ts';

type Root = BudgetState['roots'][number];
export type RootStopReason = 'requester_stop' | 'turn_ended' | 'access_revoked';
type Append = (type: string, payload: unknown) => Promise<void>;

export async function readRootStopEvidence(store: EventStore, subject: string, position: number) {
  try {
    if (!Number.isSafeInteger(position) || position < 1) {
      throw new Error('Invalid position');
    }
    const deadline = performance.now() + 10_000;
    const saved = await readEventAt(store, subject, position, deadline);
    const parsed = parseEventByType(saved?.event);
    if (!saved || !parsed.success || parsed.event.subject !== subject) {
      throw new Error('Missing source event');
    }
    return { sequence: saved.sequence, event: parsed.event };
  } catch {
    // Keep store errors and evidence identities out of the caller's error.
    throw new Error('Root stop evidence refused');
  }
}

function matchesTurn(root: Root, fields: Record<string, unknown>) {
  return fields['conversationId'] === root.conversationId && fields['turnId'] === root.turnId;
}
function matchesRequesterStop(root: Root, event: EventEnvelope) {
  const fields = data(event);
  return event.subject === `conversation-${root.conversationId}` &&
    event.type === 'agent.turn_stop_requested' && matchesTurn(root, fields) &&
    fields['requestedBy'] === root.requesterId;
}
function matchesTurnEnd(root: Root, event: EventEnvelope) {
  const fields = data(event);
  if (!matchesTurn(root, fields)) return false;
  if (event.type === 'computer.turn_closed') {
    return event.subject === `computer-${root.assistantId}` && fields['task'] === 'chat_turn' &&
      fields['assistantId'] === root.assistantId && fields['computerId'] === root.computerId &&
      fields['requesterId'] === root.requesterId;
  }
  return event.subject === `conversation-${root.conversationId}` &&
    (event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed');
}
function matchesAccessLoss(root: Root, event: EventEnvelope) {
  const fields = data(event);
  if (event.type === 'member.removed') {
    return event.subject === `member-${root.requesterId}` && fields['memberId'] === root.requesterId;
  }
  if (event.subject !== `participation-${root.conversationId}` ||
      fields['conversationId'] !== root.conversationId) {
    return false;
  }
  return event.type === 'conversation.closed' ||
    (event.type === 'participant.removed' && fields['participantId'] === root.requesterId);
}
function matchesReason(root: Root, reason: RootStopReason, event: EventEnvelope) {
  switch (reason) {
    case 'requester_stop': return matchesRequesterStop(root, event);
    case 'turn_ended': return matchesTurnEnd(root, event);
    case 'access_revoked': return matchesAccessLoss(root, event);
    default: return false;
  }
}
export async function saveRootStop(state: BudgetState, silo: string, rootId: string,
  reason: RootStopReason, source: StoredEvent, append: Append) {
  function matchesRoot(root: Root) {
    return root.rootId === rootId;
  }
  const root = state.roots.find(matchesRoot);
  if (!root || source.event.silo !== silo || !matchesReason(root, reason, source.event)) {
    throw new Error('Root stop evidence refused');
  }
  // Reject access loss from before this root existed, including removal before re-invitation.
  if (reason === 'access_revoked' && source.sequence < root.position) {
    throw new Error('Root stop evidence refused');
  }
  // Keep the first saved reason even when a later valid source gives another reason.
  if (root.stop) return root.stop;
  const stop = { rootId, reason, sourceSubject: source.event.subject,
    sourcePosition: source.sequence, sourceEventId: source.event.id };
  await append('budget.root_stopped', stop);
  return root.stop!;
}
