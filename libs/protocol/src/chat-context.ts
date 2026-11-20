import { z } from 'zod';
import { chatContextSchema } from './chat.ts';

export const chatContextSubscribeSchema = z.object({
  type: z.literal('subscribe'), topic: z.literal('chat-context'),
}).strict();

export const chatContextMessageSchema = z.object({
  type: z.literal('context'), topic: z.literal('chat-context'), data: chatContextSchema,
}).strict();
