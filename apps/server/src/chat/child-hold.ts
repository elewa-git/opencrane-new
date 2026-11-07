import { readEventAt, type EventStore } from '@opencrane/event-store';
import { childActivatedEventSchema, conversationCreatedDataSchema } from '@opencrane/events';

// Let a checked activation prepare a thread; the first model pass still needs root admission.
export async function childRequestStage(options: { store: EventStore; silo: string },
  data: unknown) {
  const created = conversationCreatedDataSchema.parse(data);
  if (!('contextKind' in created)) return 'legacy' as const;
  const origin = created.origin;
  const intent = await readEventAt(options.store, `conversation-${origin.parentConversationId}`,
    origin.intentPosition, performance.now() + 10_000);
  // Leave old fixture children without a saved intent usable.
  if (intent?.event.id !== origin.intentEventId ||
      intent.event.silo !== options.silo) return 'legacy' as const;
  const subject = `conversation-${created.conversationId}`;
  const deadline = performance.now() + 10_000;
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== options.silo) throw new Error('Child activation unavailable');
    if (row.event.type !== 'conversation.child_activated') continue;
    const parsed = childActivatedEventSchema.safeParse(row.event);
    if (!parsed.success) throw new Error('Child activation unavailable');
    const activation = parsed.data.data;
    if (activation.intentEventId !== origin.intentEventId ||
        activation.firstInputId !== origin.firstInputId ||
        activation.conversationId !== created.conversationId) return 'held' as const;
    return 'activated' as const;
  }
  return 'held' as const;
}

export async function childRequestHeld(options: { store: EventStore; silo: string;
  childStartUrl?: string },
  data: unknown) {
  const stage = await childRequestStage(options, data);
  return stage === 'held' || (stage === 'activated' && !options.childStartUrl);
}
