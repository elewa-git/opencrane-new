import { z } from 'zod';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const modelId = z.string().regex(/^[\w.-]{1,200}$/u);
const kind = z.enum(['member', 'team', 'assistant']);
const projectionState = z.object({
  content: z.enum(['current', 'applying']),
  sequence: z.int().nonnegative(),
}).strict();

export const modelAccessGrantSchema = z.object({
  granteeKind: kind,
  granteeId: id,
  displayName: z.string().min(1).max(200),
  source: z.enum(['direct', 'group', 'assistant']),
  state: z.enum(['granted', 'revoked']),
  eventId: id,
  eventTime: z.iso.datetime(),
  sequence: z.int().positive(),
  projection: z.enum(['current', 'applying']),
}).strict();

export const modelAccessResponseSchema = z.object({
  modelId,
  expectedSequence: z.int().nonnegative(),
  loadedAt: z.iso.datetime(),
  canManage: z.boolean(),
  grants: z.array(modelAccessGrantSchema).max(100),
  grantTotal: z.int().nonnegative(),
  explanations: z.object({
    configuredUses: z.object({ status: z.literal('not_available_yet') }).strict(),
  }).strict(),
  availability: z.object({
    registrySupported: z.boolean(),
    selectedConnection: z.object({ status: z.literal('not_available_yet') }).strict(),
    enabledModel: z.object({ status: z.literal('not_available_yet') }).strict(),
    connection: z.object({ status: z.literal('not_available_yet') }).strict(),
    key: z.object({ status: z.literal('not_available_yet') }).strict(),
    verification: z.object({ status: z.literal('not_available_yet') }).strict(),
  }).strict(),
  projection: projectionState,
}).strict();

export const modelAccessCandidatesQuerySchema = z.object({
  kind,
  after: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const modelAccessCandidateSchema = z.object({
  id,
  displayName: z.string().min(1).max(200),
  memberCount: z.int().nonnegative().optional(),
}).strict();

export const modelAccessCandidatesResponseSchema = z.object({
  rows: z.array(modelAccessCandidateSchema),
  next: id.nullable(),
  loadedAt: z.iso.datetime(),
  projection: projectionState,
}).strict();

export type ModelAccessResponse = z.infer<typeof modelAccessResponseSchema>;
export type ModelAccessCandidatesResponse = z.infer<typeof modelAccessCandidatesResponseSchema>;
