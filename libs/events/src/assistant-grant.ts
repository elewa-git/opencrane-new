import { z } from 'zod';
import { recordIdSchema } from './ids.ts';

export const assistantGrantSchema = z.discriminatedUnion('resourceType', [
  z.object({ resourceType: z.literal('model'),
    resourceId: z.string().regex(/^[\w.-]{1,200}$/u) }).strict(),
  z.object({ resourceType: z.literal('mcp_server'),
    resourceId: recordIdSchema }).strict(),
]);
