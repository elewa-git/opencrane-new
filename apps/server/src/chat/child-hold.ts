import { readEventAt, type EventStore } from '@opencrane/event-store';
import { conversationCreatedDataSchema } from '@opencrane/events';

// Hold saved requests until child activation and its spending checks are available.
export async function childRequestHeld(options: { store: EventStore; silo: string },
  data: unknown) {
  const created = conversationCreatedDataSchema.parse(data);
  if (!('contextKind' in created)) return false;
  const origin = created.origin;
  const intent = await readEventAt(options.store, `conversation-${origin.parentConversationId}`,
    origin.intentPosition, performance.now() + 10_000);
  // Leave old fixture children without a saved intent usable. Read failures still hold work.
  return intent?.event.id === origin.intentEventId;
}
