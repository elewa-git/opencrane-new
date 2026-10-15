import { z } from 'zod';
import { budgetRootAllowanceSetDataSchema } from './budget-root.ts';
import { chatIdSchema, sharedChildConversationSchema } from './conversation.ts';
import { eventEnvelopeSchema } from './envelope.ts';
import { event } from './definition.ts';

const fields = sharedChildConversationSchema.shape;
const request = z.strictObject({
  conversationId: fields.conversationId, sourceMessageId: chatIdSchema,
  sourcePosition: z.int().positive(), requestId: chatIdSchema,
  childConversationId: fields.conversationId, firstInputId: chatIdSchema,
  createdBy: chatIdSchema, assistantId: chatIdSchema, payingGroupId: chatIdSchema,
  allowanceBoundCents: budgetRootAllowanceSetDataSchema.shape.allowanceCents,
  initialJoins: fields.initialJoins,
});
export type ChildRequest = z.infer<typeof request>;
function validReferences(data: ChildRequest) {
  const people = new Set<string>();
  for (const join of data.initialJoins) {
    if (people.has(join.participantId) || join.parentJoinPosition >= data.sourcePosition) {
      return false;
    }
    people.add(join.participantId);
  }
  return people.has(data.createdBy) && data.childConversationId !== data.conversationId;
}
export const childRequestedDataSchema = request.refine(validReferences);
const envelope = eventEnvelopeSchema(childRequestedDataSchema);
function validWriter(saved: z.infer<typeof envelope>) {
  return saved.type === 'conversation.child_requested' &&
    saved.subject === `conversation-${saved.data.conversationId}` &&
    saved.source === 'opencrane-server' && saved.report === undefined &&
    saved.commandId === saved.id && saved.principal?.kind === 'human' &&
    saved.principal.id === saved.data.createdBy;
}
export const childRequestedEventSchema = envelope.refine(validWriter);
const example: ChildRequest = { conversationId: 'parent', sourceMessageId: 'source',
  sourcePosition: 2, requestId: 'request', childConversationId: 'child', firstInputId: 'input',
  createdBy: 'alice', assistantId: 'assistant', payingGroupId: 'team', allowanceBoundCents: 1000,
  initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }] };
export const childRequestEvent = event('conversation.child_requested', 'conversation',
  'The server saved a reviewed child request without copying source text.',
  childRequestedDataSchema, example);
