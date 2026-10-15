import { conversationEventId, type EventEnvelope, type HandlerName } from '@opencrane/events';

/** Keep creation and participation changes in event order across their two streams. */
export function handlerJobKey(handler: HandlerName, event: EventEnvelope): string {
  if (handler === 'prepare-gateway-configuration') {
    return `gateway-config-${event.silo}`;
  }
  const conversationEvent = ['conversation.created', 'participant.added', 'participant.removed'];
  if (handler === 'update-openfga' && conversationEvent.includes(event.type)) {
    return `conversation-${conversationEventId(event)}`;
  }
  return event.subject;
}
