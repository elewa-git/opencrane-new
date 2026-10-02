import { z } from 'zod';
export const chatSubscribeSchema = z.object({ type: z.literal('subscribe'), topic: z.literal('conversation'),
  conversationId: z.string().regex(/^[\w-]{1,200}$/u), since: z.int().nonnegative(), generation: z.int().nonnegative().optional() }).strict();
export const chatMessageSchema = z.object({ version: z.literal(1), topic: z.literal('conversation'), conversationId: z.string(),
  type: z.enum(['event', 'ready', 'resync', 'refused']), position: z.int().nonnegative(), generation: z.int().nonnegative(),
  row: z.object({ id: z.string(), position: z.int().nonnegative(), type: z.string(), data: z.unknown(), time: z.string() }).optional(),
  computerState: z.string().optional(),
}).strict();

// Browser reads are validated here once; future event fields remain opaque.
export const chatRowSchema = z.object({ id: z.string(), position: z.int().nonnegative(), type: z.string(), time: z.string(),
  data: z.object({ text: z.string().optional(), turnId: z.string().optional(), messageId: z.string().optional(),
    authorId: z.string().optional(), path: z.string().optional(), exitCode: z.number().optional(), commandDigest: z.string().optional(),
    reason: z.string().optional(), contentType: z.string().optional() }).passthrough(),
});
export const chatFeedSchema = z.object({ rows: z.array(chatRowSchema), position: z.int().nonnegative(), generation: z.int().nonnegative(), computerState: z.string() });
export const chatListSchema = z.object({ rows: z.array(z.object({ conversationId: z.string(), assistantId: z.string(), createdBy: z.string(),
  title: z.string().optional(), status: z.enum(['open', 'working', 'done', 'closed', 'failed']).optional(),
  mode: z.enum(['agent_session', 'direct', 'group']).default('agent_session'), createdAt: z.string() })) });
export const chatContextSchema = z.object({ memberId: z.string(), assistantId: z.string().nullable() });
export type ChatRow = z.infer<typeof chatRowSchema>;
export type ChatConversation = z.infer<typeof chatListSchema>['rows'][number];
