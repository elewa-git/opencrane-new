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
  startupReviewRequired: z.boolean().optional(), published: z.boolean(),
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
