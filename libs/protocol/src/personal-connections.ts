import { recordIdSchema } from '@opencrane/events';
import { z } from 'zod';

const identifier = recordIdSchema;
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
  selectedProfileId: identifier.optional(),
  allowedAssistantIds: z.array(identifier).max(100).optional(),
}).strict();
export const personalKeyCommandSchema = z.object({
  action: z.enum(['create', 'rotate']), connectionId: identifier, changeRef: identifier,
  expectedSequence: z.int().nonnegative(), expectedGeneration: z.int().nonnegative(),
  material: z.string().regex(/^[\x21-\x7e]{1,4096}$/u),
}).strict();

export const personalConnectionNeedsSchema = z.object({ rows: z.array(z.object({
  serverId: identifier, name: z.string().min(1).max(200),
  reason: z.enum(['connection_required', 'assistant_not_allowed']).optional(),
}).strict()) }).strict();

const selectionFields = { connectionId: identifier, changeRef: identifier,
  expectedSequence: z.int().nonnegative() };
const personalSelection = z.strictObject({ ...selectionFields, action: z.literal('select'),
  profileId: identifier, profileRevision: z.int().positive(),
  ownerKind: z.literal('personal').optional(),
  allowedAssistantIds: personalConnectionSettingsSchema.shape.allowedAssistantIds });
const companySelection = z.strictObject({ ...selectionFields, action: z.literal('select'),
  profileId: identifier, profileRevision: z.int().positive(), ownerKind: z.literal('company') });
const clearSelection = z.strictObject({ ...selectionFields, action: z.literal('clear') });
export const connectionSelectionBodySchema = z.union([
  personalSelection, companySelection, clearSelection,
]);
export const connectionSelectionCommandSchema = z.union([
  personalSelection.extend({ serverId: identifier }),
  companySelection.extend({ serverId: identifier }),
  clearSelection.extend({ serverId: identifier }),
]);
