import { hostedImageCheckedSchema, mcpConfigurationObservationSchema,
  mcpPublicationIntentDataSchema } from '@opencrane/events';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { z } from 'zod';

export const sharedStateKindSchema = z.enum([
  'not_configured', 'draft', 'checking', 'needs_input', 'ready',
  'failed', 'unknown', 'access_changed', 'disabled',
]);

export const integrationRowSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  source: z.object({
    kind: z.enum(['catalogue', 'remote_url', 'package']),
    label: z.string().min(1),
    detail: z.string().min(1),
  }).strict(),
  version: z.string().min(1),
  accountModel: z.string().min(1),
  toolsAllowed: z.number().int().nonnegative(),
  toolsTotal: z.number().int().nonnegative().nullable(),
  status: z.object({
    kind: sharedStateKindSchema,
    label: z.string().min(1),
    detail: z.string().min(1),
    safeToRetry: z.boolean().optional(),
  }).strict(),
}).strict();

export const integrationsResponseSchema = z.object({
  rows: z.array(integrationRowSchema),
  loadedAt: z.iso.datetime({ offset: true }),
}).strict();

export const integrationsRefusalSchema = z.object({
  status: z.literal('refused'),
  reason: z.enum(['no_session', 'wrong_silo', 'admin_required']),
  requiredRole: z.literal('Owner or Admin').optional(),
}).strict();

export type SharedStateKind = z.infer<typeof sharedStateKindSchema>;
export type IntegrationRow = z.infer<typeof integrationRowSchema>;
export type IntegrationsResponse = z.infer<typeof integrationsResponseSchema>;

export const toolPolicySchema = z.object({
  silo: z.string().nullable().default(null), serverId: z.string().nullable().default(null),
  connectionId: z.string().nullable(), accountMode: z.enum(['none', 'personal', 'company']).nullable(),
  startupReviewRequired: z.boolean().optional(), rejected: z.boolean().optional(),
  published: z.boolean(),
  driftHeld: z.boolean().optional(), reviewRevision: z.int().positive().optional(),
  publication: mcpPublicationIntentDataSchema.optional(),
  publicationRevision: z.int().positive().optional(),
  configurationObservation: mcpConfigurationObservationSchema.optional(),
  sequence: z.int().nonnegative(),
  policyRevision: z.int().nonnegative().default(0),
  catalogue: mcpServerDiscoveredDataSchema.nullable().default(null),
  previousCatalogue: mcpServerDiscoveredDataSchema.nullable().default(null),
  checkedAt: z.iso.datetime().nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
  tools: z.array(z.object({ name: z.string(), revision: z.string(), reviewed: z.boolean(),
    readOnly: z.boolean(), costCents: z.literal(0).optional(), mode: z.enum(['allow', 'ask', 'block']), suggestion: z.enum(['allow', 'ask']) })),
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const hostedAdmissionSchema = z.strictObject({
  ...hostedImageCheckedSchema.shape,
  queuedAt: z.iso.datetime(),
  status: z.enum(['checking', 'rejected', 'unavailable', 'admitted', 'expired']),
  checks: hostedImageCheckedSchema.shape.checks.optional(),
});


const factId = z.string().regex(/^[\w-]{1,200}$/u);
const factDate = z.iso.datetime({ offset: true });
const factProgress = z.enum(['current', 'applying']);
const savedGrantFact = z.strictObject({
  granteeKind: z.enum(['member', 'team', 'assistant']), granteeId: factId,
  state: z.enum(['granted', 'revoked']), eventId: factId, eventTime: factDate,
  sequence: z.int().positive(), iam: factProgress, projection: factProgress,
  membershipStatus: z.enum(['joined', 'invited', 'departed', 'unknown']).nullable(),
});
const savedPublicationFact = z.strictObject({
  status: z.enum(['disabled', 'applying', 'unknown', 'ready']),
  changeRef: factId.optional(), requestedAt: factDate.optional(), observedAt: factDate.optional(),
  generation: z.int().positive().optional(),
  recordDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  stage: z.enum(['read', 'preparation', 'observation', 'receipt']).optional(),
  reason: z.enum(['unavailable', 'not_prepared', 'not_current', 'deadline', 'not_observed']).optional(),
});
export const integrationFactsSchema = z.strictObject({
  serverId: factId, loadedAt: factDate,
  installed: z.strictObject({
    status: z.literal('registered'), eventId: factId, recordedAt: factDate,
    sequence: z.int().positive(),
  }),
  connected: z.strictObject({
    status: z.enum(['unknown', 'no_account_required', 'verification_unavailable']),
    accountMode: z.enum(['none', 'personal', 'company']).nullable(),
    connectionId: factId.nullable(), checkedAt: factDate.nullable(),
  }),
  allowedFor: z.strictObject({
    basis: z.literal('saved_grants'), complete: z.boolean(), grantTotal: z.int().nonnegative().nullable(),
    sequence: z.int().nonnegative(), projection: factProgress, iam: factProgress,
    grants: z.array(savedGrantFact).max(100),
  }),
  availability: z.strictObject({
    status: z.literal('unavailable'), reason: z.literal('requester_assistant_required'),
    policy: z.enum(['current', 'unavailable']), sequence: z.int().nonnegative(),
    reviewRevision: z.int().positive().nullable(), checkedAt: factDate.nullable(),
    expiresAt: factDate.nullable(), publication: savedPublicationFact,
  }),
});
