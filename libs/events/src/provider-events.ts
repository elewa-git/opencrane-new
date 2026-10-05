import { centsSchema, connectionCreatedDataSchema } from './data.ts';
import { z } from 'zod';
import { event } from './definition.ts';

export const providerIdSchema = z.string().regex(/^[\w-]{1,200}$/u);
export const providerModelIdSchema = z.string().regex(/^[\w.-]{1,200}$/u);
const id = providerIdSchema;
const modelId = providerModelIdSchema;
const revision = z.int().positive();
const providerCreatedSchema = z.object({
  providerId: id, provider: z.enum(['openai', 'anthropic']),
  name: z.string().trim().min(1).max(200), revision, changedBy: id,
}).strict();
const base = { providerId: id, revision, changedBy: id };
export const providerKeySchema = z.object({ ...base,
  secretRef: connectionCreatedDataSchema.shape.secretRef,
}).strict();
export const providerModelsSchema = z.object({ ...base,
  models: z.array(modelId).max(11) }).strict();
const verification = { ...base, attemptId: id, kind: z.enum(['reachability', 'model']),
  model: modelId.optional(), reservedCents: centsSchema.optional() };
export const providerRequestedSchema = z.object(verification).strict();
export const providerDispatchedSchema = z.object({ ...verification,
  reservationId: z.uuid().optional() }).strict();
export const providerResultSchema = z.object({ ...verification,
  reservationId: z.uuid().optional(), settledCents: centsSchema.optional(),
  outcome: z.enum(['pass', 'fail', 'unknown', 'skipped', 'budget_refused']),
}).strict();
const verificationExample = { providerId: 'primary', revision: 2, changedBy: 'owner',
  attemptId: 'verify-primary', kind: 'reachability' as const };
const example = {
  providerId: 'primary', provider: 'openai' as const, name: 'Primary', revision: 1,
  changedBy: 'owner',
};
export const providerEvents = [
  event('provider.created', 'provider', 'An admin named a provider connection.',
    providerCreatedSchema, example),
  event('provider.key_saved', 'provider', 'A key reference was saved; old evidence is invalid.',
    providerKeySchema, { providerId: 'primary', revision: 2, changedBy: 'owner',
      secretRef: `secret:provider-${'0'.repeat(64)}` }),
  event('provider.models_selected', 'provider', 'An admin selected registry models without grants.',
    providerModelsSchema, { providerId: 'primary', revision: 3, changedBy: 'owner',
      models: ['gpt-6.1-sol'] }),
  event('provider.verification_requested', 'provider', 'An admin requested a revision-bound check.',
    providerRequestedSchema, verificationExample),
  event('provider.verification_dispatched', 'provider', 'A check consumed its single dispatch.',
    providerDispatchedSchema, verificationExample),
  event('provider.verification_recorded', 'provider', 'Safe dated check evidence was recorded.',
    providerResultSchema, { ...verificationExample, outcome: 'pass' }),
];
