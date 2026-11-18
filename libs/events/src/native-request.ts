import { recordIdSchema } from './ids.ts';
import { z } from 'zod';
import { isToolCallText } from './tool-call.ts';

export const agentNativeRequestRefusedDataSchema = z.object({
  conversationId: recordIdSchema,
  turnId: recordIdSchema,
  nativeRequestId: z.string().refine(isToolCallText),
  requestKind: z.enum(['shell', 'file_change', 'permissions', 'user_input', 'other']),
  outcome: z.enum(['declined', 'unsupported']),
}).strict();
