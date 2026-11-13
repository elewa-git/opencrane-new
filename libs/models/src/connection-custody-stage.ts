import { z } from 'zod';

export const connectionIdentifierSchema = z.string().min(1).max(200);
const stageSchema = z.object({
  siloId: connectionIdentifierSchema, userId: connectionIdentifierSchema,
  serverId: connectionIdentifierSchema, connectionId: connectionIdentifierSchema,
  profileId: connectionIdentifierSchema, purpose: z.enum(['personal', 'validation']),
  generation: z.int().positive(), endpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: connectionIdentifierSchema, expectedSequence: z.int().nonnegative(),
  appendUntil: z.int().positive(),
  attemptId: connectionIdentifierSchema.optional(), attemptDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type ConnectionStage = z.infer<typeof stageSchema>;
const companyStageSchema = stageSchema.omit({ userId: true }).extend({
  ownerKind: z.literal('company'), purpose: z.literal('company'),
  custodianId: connectionIdentifierSchema,
  registrationRevision: z.int().positive(), optInRevision: z.int().positive(),
});
export type CompanyConnectionStage = z.infer<typeof companyStageSchema>;
export type CustodyStage = ConnectionStage | CompanyConnectionStage;
export const custodyStageSchema = z.union([stageSchema, companyStageSchema]);
