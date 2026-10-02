import { z } from 'zod';
export const chatSubscribeSchema = z.object({ type: z.literal('subscribe'), topic: z.literal('conversation'),
  conversationId: z.string().regex(/^[\w-]{1,200}$/u), since: z.int().nonnegative(), generation: z.int().nonnegative().optional() }).strict();
export const chatMessageSchema = z.object({ version: z.literal(1), topic: z.literal('conversation'), conversationId: z.string(),
  type: z.enum(['event', 'ready', 'resync', 'refused']), position: z.int().nonnegative(), generation: z.int().nonnegative(),
  row: z.object({ id: z.string(), position: z.int().nonnegative(), type: z.string(), data: z.unknown(), time: z.string() }).optional(),
  computerState: z.string().optional(),
}).strict();
