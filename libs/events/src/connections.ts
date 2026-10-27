import { z } from 'zod';

const id = z.string().min(1);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const secretRefSchema = z
  .string()
  .regex(
    /^secret:[A-Za-z0-9_-]+$/,
    'secretRef must be an opaque reference, e.g. "secret:<id>", never the credential value itself',
  );

// Keep old profiles readable. Require all activation details together for new generations.
const connectionId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const activationFields = z.strictObject({
  connectionId, ownerKind: z.literal('personal'), purpose: z.literal('personal'),
  generation: z.int().positive(), uid: connectionId, resourceVersion: connectionId,
  endpointDigest: digestSchema, operationId: connectionId, changedBy: connectionId,
  expectedSequence: z.int().nonnegative(), appendUntil: z.int().positive(),
});
const bearerActivationSchema = activationFields.extend({
  reason: z.enum(['bearer_create', 'bearer_rotation']),
});
const connectionActivationSchema = z.discriminatedUnion('reason', [
  bearerActivationSchema,
  activationFields.extend({ reason: z.literal('oauth_confirmed'),
    configurationDigest: digestSchema.optional(), account: z.strictObject({
    issuer: z.url().max(2048), subject: z.string().regex(/^[\x21-\x7e]{1,255}$/u),
    scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/u)).max(64),
    expiresAt: z.int().positive(),
  }) }),
]);
export const connectionCreatedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, secretRef: secretRefSchema,
    activation: connectionActivationSchema.optional() })
  .strict();

export const connectionRefreshedDataSchema = connectionCreatedDataSchema.extend({
  activation: connectionActivationSchema.optional(),
});

export const connectionOAuthStartedDataSchema = z.strictObject({
  userId: connectionId, serverId: connectionId, connectionId, profile: connectionId,
  attemptId: digestSchema, attemptDigest: digestSchema, stateDigest: digestSchema,
  secretRef: secretRefSchema, uid: connectionId, resourceVersion: connectionId,
  expectedSequence: z.literal(0), appendUntil: z.int().positive(),
});

export const connectionOAuthExchangeClaimedDataSchema = z.strictObject({
  userId: connectionId, serverId: connectionId, connectionId, profile: connectionId,
  attemptId: digestSchema, workerId: connectionId, purpose: z.enum(['consent', 'refresh']),
  secretRef: secretRefSchema, uid: connectionId, resourceVersion: connectionId,
  expectedSequence: z.int().positive(), appendUntil: z.int().positive(),
});

export const connectionRevokedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, revokedBy: id,
    expectedSequence: z.int().nonnegative().optional(),
    reason: z.literal('owner_requested').optional() })
  .strict();

export const connectionDisabledDataSchema = z.strictObject({
  userId: connectionId, serverId: connectionId, profile: connectionId,
  disabledBy: connectionId, expectedSequence: z.int().nonnegative(),
  reason: z.literal('admin_disabled'),
});

export const connectionOperationClosedDataSchema = z.strictObject({
  userId: connectionId, serverId: connectionId, profile: connectionId,
  operationId: connectionId, generation: z.int().positive(),
  expectedSequence: z.int().nonnegative(), appendUntil: z.int().positive(),
  reason: z.literal('append_deadline_passed'),
});

const selectionFields = { userId: connectionId, serverId: connectionId, connectionId,
  expectedSequence: z.int().nonnegative() };
export const connectionSelectedDataSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...selectionFields, action: z.literal('select'),
    profileId: connectionId, profileRevision: z.int().positive() }),
  z.strictObject({ ...selectionFields, action: z.literal('clear') }),
]);

export const companyOptInSetDataSchema = z.strictObject({
  serverId: connectionId, connectionId, registrationRevision: z.int().positive(),
  enabled: z.boolean(), changedBy: connectionId, expectedSequence: z.int().nonnegative(),
});

export const connectionRefreshStartedDataSchema = z.strictObject({
  userId: connectionId, serverId: connectionId, connectionId, profile: connectionId,
  attemptId: digestSchema, configurationDigest: digestSchema,
  generation: z.int().positive(), expectedSequence: z.int().positive(),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/u)).max(64),
});
