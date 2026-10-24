import { childActivatedEvent } from './child-activation.ts';
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
const childRequestEvent = event('conversation.child_requested', 'conversation',
  'The server saved a reviewed child request without copying source text.',
  childRequestedDataSchema, example);

export const childStartFailedDataSchema = z.strictObject({
  conversationId: chatIdSchema, requestId: chatIdSchema, childConversationId: chatIdSchema,
  intentEventId: chatIdSchema, attempt: z.int().min(1).max(3),
  stage: z.enum(['create', 'first_input', 'activation']),
  reason: z.enum(['access_refused', 'conversation_closed', 'record_changed']),
});
const failedEnvelope = eventEnvelopeSchema(childStartFailedDataSchema);
function validFailureWriter(saved: z.infer<typeof failedEnvelope>) {
  return saved.type === 'conversation.child_start_failed' &&
    saved.subject === `conversation-${saved.data.conversationId}` &&
    saved.source === 'opencrane-server' && saved.report === undefined &&
    saved.commandId === saved.id && saved.principal?.kind === 'system' &&
    saved.principal.id === 'opencrane-server';
}
export const childStartFailedEventSchema = failedEnvelope.refine(validFailureWriter);
const failureExample = { conversationId: 'parent', requestId: 'request',
  childConversationId: 'child', intentEventId: 'intent', attempt: 1,
  stage: 'create', reason: 'access_refused' } as const;
const childStartFailedEvent = event('conversation.child_start_failed', 'conversation',
  'The server saved a proven refusal before a child could start.',
  childStartFailedDataSchema, failureExample);

export const childRetryRequestedDataSchema = z.strictObject({
  conversationId: chatIdSchema, requestId: chatIdSchema, retryId: chatIdSchema,
  failureEventId: chatIdSchema, attempt: z.int().min(2).max(3),
});
const retryEnvelope = eventEnvelopeSchema(childRetryRequestedDataSchema);
function validRetryWriter(saved: z.infer<typeof retryEnvelope>) {
  return saved.type === 'conversation.child_retry_requested' &&
    saved.subject === `conversation-${saved.data.conversationId}` &&
    saved.source === 'opencrane-server' && saved.report === undefined &&
    saved.commandId === saved.id && saved.principal?.kind === 'human';
}
export const childRetryRequestedEventSchema = retryEnvelope.refine(validRetryWriter);
const retryExample = { conversationId: 'parent', requestId: 'request', retryId: 'retry',
  failureEventId: 'failure', attempt: 2 };
const childRetryRequestedEvent = event('conversation.child_retry_requested', 'conversation',
  'The requester asked to resume a saved child failure with the original choices.',
  childRetryRequestedDataSchema, retryExample);

export const childRequestEvents = [
  childRequestEvent, childStartFailedEvent, childRetryRequestedEvent, childActivatedEvent,
];
