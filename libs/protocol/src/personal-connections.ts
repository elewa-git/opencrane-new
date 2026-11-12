import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const personalProfileMetadataSchema = z.object({
  serverId: identifier, profileId: identifier, profileRevision: z.int().positive(),
  status: z.enum(['saved_unverified', 'verified', 'unavailable']),
  generation: z.int().positive().nullable(), adminBlocked: z.boolean(),
  serverAvailable: z.boolean(), callsAvailable: z.literal(false),
  accountLabel: z.string().max(255).optional(), controlRevision: z.int().nonnegative().optional(),
}).strict();
export type PersonalProfileMetadata = z.infer<typeof personalProfileMetadataSchema>;

export const personalConnectionSettingsSchema = z.object({
  serverId: identifier, connectionId: identifier, identityTool: z.string().min(1),
  selectionRevision: z.int().nonnegative(),
}).strict();
export const personalKeyCommandSchema = z.object({
  action: z.enum(['create', 'rotate']), connectionId: identifier, changeRef: identifier,
  expectedSequence: z.int().nonnegative(), expectedGeneration: z.int().nonnegative(),
  material: z.string().regex(/^[\x21-\x7e]{1,4096}$/u),
}).strict();

export const personalConnectionNeedsSchema = z.object({ rows: z.array(z.object({
  serverId: identifier, name: z.string().min(1).max(200),
}).strict()) }).strict();
