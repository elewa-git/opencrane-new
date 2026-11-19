import { z } from 'zod';
import { storageSafeTextSchema } from './conversation-prose.ts';
import { digestSchema, id } from './data.ts';
import { commandActivityLabels } from './command-activity-label.ts';

export const commandActivityLabelSchema = z.enum(commandActivityLabels);
const commandViewSchema = z.object({ preview: storageSafeTextSchema.max(32768) }).strict();

// Retain only the reviewed, redacted command preview.
export const agentCommandRanDataSchema = z.object({
  conversationId: id,
  turnId: id,
  commandDigest: digestSchema,
  exitCode: z.int().min(0).max(255),
  activityLabel: commandActivityLabelSchema.optional(),
  view: commandViewSchema.optional(),
}).strict();
