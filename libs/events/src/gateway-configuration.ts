import { z } from 'zod';
import { mcpServerReviewedDataSchema } from './data.ts';
import { event } from './definition.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reviewFields = mcpServerReviewedDataSchema.omit({ policyRevision: true, reviewedBy: true });
export const gatewayEntrySchema = reviewFields.extend({ reviewRevision: z.int().positive() });
export const gatewayConfigurationSchema = z.strictObject({
  changeRef: z.string().min(1), generation: z.int().positive(), rendererVersion: z.literal('1'),
  members: z.array(z.strictObject({ entry: gatewayEntrySchema, changeRef: z.string().min(1),
    sourceSequence: z.int().positive(), fragmentDigest: digest })).max(1000),
  recordDigest: digest,
});
export const gatewayConfigurationEvent = event(
  'gateway.configuration_requested', 'gateway',
  'A complete set of reviewed tool entries was saved for gateway preparation.',
  gatewayConfigurationSchema,
  { changeRef: 'publication-1', generation: 1, rendererVersion: '1', members: [],
    recordDigest: 'a'.repeat(64) },
);

export const gatewayObservationSchema = z.strictObject({
  generation: z.int().positive(), recordDigest: digest, configDigest: digest,
  processRef: z.uuid(), outcome: z.literal('loaded'), observedAt: z.iso.datetime(),
});
export const gatewayObservationEvent = event(
  'gateway.configuration_observed', 'gateway',
  'The running gateway returned the exact saved configuration identity.',
  gatewayObservationSchema,
  { generation: 1, recordDigest: 'a'.repeat(64), configDigest: 'b'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', outcome: 'loaded',
    observedAt: '2026-10-14T00:00:00.000Z' },
);
