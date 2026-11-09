import { z } from 'zod';
import { digestSchema, id } from './data.ts';
import { commandActivityLabels } from './command-activity-label.ts';

export const commandActivityLabelSchema = z.enum(commandActivityLabels);

// Save only the digest and a fixed label. Arguments may contain private text.
export const agentCommandRanDataSchema = z.object({
  conversationId: id,
  turnId: id,
  commandDigest: digestSchema,
  exitCode: z.int().min(0).max(255),
  activityLabel: commandActivityLabelSchema.optional(),
}).strict();
