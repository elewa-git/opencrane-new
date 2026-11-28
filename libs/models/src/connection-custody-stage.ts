import { z } from 'zod';

const identifierTextSchema = z.string();
const nonEmptyIdentifierSchema = identifierTextSchema.min(1);
export const connectionIdentifierSchema = nonEmptyIdentifierSchema.max(200);
const digestTextSchema = z.string();
const digestSchema = digestTextSchema.regex(/^[a-f0-9]{64}$/u);
const integerSchema = z.int();
const positiveIntegerSchema = integerSchema.positive();
const nonNegativeIntegerSchema = integerSchema.nonnegative();
const stageFields = {
  siloId: connectionIdentifierSchema,
  userId: connectionIdentifierSchema,
  serverId: connectionIdentifierSchema,
  connectionId: connectionIdentifierSchema,
  profileId: connectionIdentifierSchema,
  purpose: z.enum(['personal', 'validation']),
  generation: positiveIntegerSchema,
  endpointDigest: digestSchema,
  operationId: connectionIdentifierSchema,
  expectedSequence: nonNegativeIntegerSchema,
  appendUntil: positiveIntegerSchema,
  attemptId: connectionIdentifierSchema.optional(),
  attemptDigest: digestSchema.optional(),
};
const stageSchema = z.strictObject(stageFields);
export type ConnectionStage = z.infer<typeof stageSchema>;
const personalOwnerFields = { userId: true } as const;
const stageWithoutPersonalOwnerSchema = stageSchema.omit(personalOwnerFields);
const companyStageFields = {
  ownerKind: z.literal('company'),
  purpose: z.literal('company'),
  custodianId: connectionIdentifierSchema,
  registrationRevision: positiveIntegerSchema,
  optInRevision: positiveIntegerSchema,
};
const companyStageSchema = stageWithoutPersonalOwnerSchema.extend(companyStageFields);
export type CompanyConnectionStage = z.infer<typeof companyStageSchema>;
export type CustodyStage = ConnectionStage | CompanyConnectionStage;
export const custodyStageSchema = z.union([stageSchema, companyStageSchema]);
