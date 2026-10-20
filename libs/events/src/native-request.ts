import { z } from 'zod';
import { isToolCallText } from './tool-call.ts';

export const agentNativeRequestRefusedDataSchema = z.object({
  conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string().regex(/^[\w-]{1,200}$/u),
  nativeRequestId: z.string().refine(isToolCallText),
  requestKind: z.enum(['shell', 'file_change', 'permissions', 'user_input', 'other']),
  outcome: z.enum(['declined', 'unsupported']),
}).strict();
