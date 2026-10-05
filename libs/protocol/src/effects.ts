import { z } from 'zod';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const priceTableId = z.string().min(1);
const cents = z.number().int().nonnegative().safe();
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  priceTableId,
}).strict();
const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider_receipt'), reference: id, digest: z.string().regex(/^[0-9a-f]{64}$/u),
    amountCents: cents,
  }).strict(),
  z.object({
    kind: z.literal('dispatch_record'), reference: id, digest: z.string().regex(/^[0-9a-f]{64}$/u),
    notDispatched: z.literal(true),
  }).strict(),
]);

export const effectStatusSchema = z.object({
  permitId: id,
  reservationId: id,
  reservedAt: z.iso.datetime({ offset: true }),
  reservedCents: cents,
  settledCents: cents.nullable(),
  model: z.string().min(1),
  priceTableId,
  sequence: z.number().int().nonnegative(),
  state: z.enum(['outcome_unknown', 'resolution_pending', 'settled', 'released']),
  label: z.string(),
  conflict: z.boolean(),
  reasons: z.array(z.enum([
    'settle_timeout', 'computer_lost', 'unknown_tariff', 'missing_usage', 'transport_failure',
  ])),
  observations: z.array(z.object({
    eventId: z.string().min(1).max(200),
    outcome: z.enum(['success', 'error']),
    costCents: cents,
    usage: usageSchema.optional(),
  }).strict()),
  resolution: z.object({
    outcome: z.enum(['settled', 'released']),
    settledCents: cents,
    evidence: z.array(evidenceSchema),
  }).strict().nullable(),
}).strict();

export const effectListResponseSchema = z.object({
  effects: z.array(effectStatusSchema),
}).strict();

export const effectDetailResponseSchema = effectStatusSchema.extend({
  csrf: z.string().min(1),
}).strict();

export type EffectStatus = z.infer<typeof effectStatusSchema>;
export type EffectDetail = z.infer<typeof effectDetailResponseSchema>;
