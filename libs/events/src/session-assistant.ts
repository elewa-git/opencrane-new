import { z } from 'zod';
import { assistantCreatedDataSchema } from './data.ts';

const selectedFields = assistantCreatedDataSchema.pick({
  kind: true, ownerId: true, payingGroupId: true,
});
const assistantFields = selectedFields.strip();
// Keep the earlier partial readers' string validation without changing saved event validation.
export const sessionAssistantSchema = assistantFields.extend({
  ownerId: z.string(),
  payingGroupId: z.string().optional(),
});
export type SessionAssistant = z.infer<typeof sessionAssistantSchema>;
