import { z } from 'zod';
import { chatIdSchema } from './conversation.ts';
import { eventEnvelopeSchema } from './envelope.ts';
import { event } from './definition.ts';

const activation = z.strictObject({
  conversationId: chatIdSchema, parentConversationId: chatIdSchema, requestId: chatIdSchema,
  intentEventId: chatIdSchema, intentPosition: z.int().positive(),
  creationEventId: chatIdSchema, creationPosition: z.int().positive(),
  firstInputId: chatIdSchema, firstInputPosition: z.int().positive(),
  requestedBy: chatIdSchema, assistantId: chatIdSchema, payingGroupId: chatIdSchema,
  attempt: z.int().min(1).max(3),
});
function ordered(data: z.infer<typeof activation>) {
  return data.parentConversationId !== data.conversationId &&
    data.intentPosition < data.creationPosition && data.creationPosition < data.firstInputPosition;
}
export const childActivatedDataSchema = activation.refine(ordered);
const envelope = eventEnvelopeSchema(childActivatedDataSchema);
function validWriter(saved: z.infer<typeof envelope>) {
  return saved.type === 'conversation.child_activated' &&
    saved.subject === `conversation-${saved.data.conversationId}` &&
    saved.source === 'opencrane-server' && saved.report === undefined &&
    saved.commandId === saved.id && saved.principal?.kind === 'human' &&
    saved.principal.id === saved.data.requestedBy;
}
export const childActivatedEventSchema = envelope.refine(validWriter);
const example = { conversationId: 'child', parentConversationId: 'parent', requestId: 'request',
  intentEventId: 'intent', intentPosition: 3, creationEventId: 'creation', creationPosition: 4,
  firstInputId: 'input', firstInputPosition: 5, requestedBy: 'alice',
  assistantId: 'assistant', payingGroupId: 'payer', attempt: 1 };
export const childActivatedEvent = event('conversation.child_activated', 'conversation',
  'The server checked the saved first child input; execution remains held.',
  childActivatedDataSchema, example);
