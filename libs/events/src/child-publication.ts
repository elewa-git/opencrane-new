import { z } from 'zod';
import { chatIdSchema } from './conversation.ts';
import { messagePostedDataSchema } from './examples.ts';
import { event } from './definition.ts';

export const childResultPublishedDataSchema = z.strictObject({
  conversationId: chatIdSchema, publishedBy: chatIdSchema, childConversationId: chatIdSchema,
  publicationKind: z.literal('final'), resultEventId: chatIdSchema,
  resultPosition: z.int().positive(), turnId: chatIdSchema,
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  ciphertext: messagePostedDataSchema.shape.ciphertext,
  keyId: messagePostedDataSchema.shape.keyId, contentType: z.literal('text'),
});
const example = { conversationId: 'parent', publishedBy: 'alice', childConversationId: 'child',
  publicationKind: 'final' as const, resultEventId: 'result', resultPosition: 2, turnId: 'turn',
  reviewDigest: 'a'.repeat(64), ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
  contentType: 'text' as const };
export const childPublicationEvent = event('conversation.child_result_published', 'conversation',
  'A person published reviewed child text to its immediate parent.',
  childResultPublishedDataSchema, example);
