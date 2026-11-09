import { z } from 'zod';
import { ciphertextSchema, digestSchema, id, keyIdSchema } from './data.ts';
import { commandActivityLabels } from './command-activity-label.ts';

export const commandActivityLabelSchema = z.enum(commandActivityLabels);
const encryptedViewSchema = z.object({ ciphertext: ciphertextSchema, keyId: keyIdSchema }).strict();

// Keep the optional view encrypted with the same key as conversation messages.
export const agentCommandRanDataSchema = z.object({
  conversationId: id,
  turnId: id,
  commandDigest: digestSchema,
  exitCode: z.int().min(0).max(255),
  activityLabel: commandActivityLabelSchema.optional(),
  view: encryptedViewSchema.optional(),
}).strict();
