import { z } from 'zod';

const checkedGrant = z.enum(['allowed', 'denied', 'unavailable']);
const source = z.object({
  kind: z.enum(['direct', 'group', 'assistant']), groupId: z.string().optional(),
  granteeKind: z.string().optional(), granteeId: z.string().optional(),
  groupName: z.string().optional(), eventId: z.string(), sequence: z.int().positive(),
  recordedAt: z.iso.datetime().optional(),
}).strict();
const toolExplanationSchema = z.object({
  assistantId: z.string(), toolName: z.string(), checkedAt: z.iso.datetime(),
  person: checkedGrant, assistant: checkedGrant, actsFor: checkedGrant,
  profile: z.enum(['not_required', 'absent_on_version', 'unsupported_history', 'unavailable']),
  mode: z.enum(['allow', 'ask', 'block']).nullable(),
  review: z.enum(['current', 'unavailable']), publication: z.literal('unavailable'),
  freshness: z.enum(['current', 'unavailable']),
  policySequence: z.int().nonnegative(), policyRevision: z.int().nonnegative(),
  catalogueCheckedAt: z.iso.datetime().nullable(), catalogueExpiresAt: z.iso.datetime().nullable(),
  availability: z.literal('unavailable'), reasons: z.array(z.string()),
}).strict();
export const toolAccessExplanationSchema = toolExplanationSchema.extend({
  serverId: z.string(), requesterId: z.string(), sources: z.array(source),
  complete: z.boolean(), unavailableSections: z.array(z.string()), reviewRevision: z.string(),
}).strict();
export type ToolExplanation = z.infer<typeof toolExplanationSchema>;

const accessRow = z.object({
  resourceType: z.string(), resourceId: z.string(), label: z.string().optional(),
  relation: z.enum(['use', 'acts_for']), sources: z.array(source),
  eligibility: z.object({
    person: checkedGrant,
    assistants: z.array(z.object({ assistantId: z.string(), grant: checkedGrant }).strict()),
    availability: z.literal('unavailable'),
    toolExplanations: z.array(toolExplanationSchema).max(50).optional(),
    toolExplanationTotal: z.int().nonnegative().nullable().optional(),
  }).strict(),
}).strict();
export const memberAccessSchema = z.object({
  checkedAt: z.iso.datetime(), complete: z.boolean(), unavailableSections: z.array(z.string()),
  rows: z.array(accessRow),
}).strict();
const versionAbsence = z.object({
  status: z.enum(['absent_on_version', 'unsupported_history', 'unavailable']), message: z.string(),
}).strict();
export const memberDepartureSchema = memberAccessSchema.omit({ rows: true }).extend({
  memberSequence: z.int().nonnegative(), ownershipSequence: z.int().nonnegative(),
  reviewRevision: z.string(), accessLost: z.array(accessRow),
  ownedSharedWork: z.array(z.string()), routines: versionAbsence,
  personalConnections: versionAbsence,
  personalComputer: z.array(z.object({
    assistantId: z.string(), computerId: z.string().nullable(), status: z.string(),
  }).strict()),
  retainedHistory: z.object({
    count: z.int().nonnegative(), firstAt: z.string().nullable(), lastAt: z.string().nullable(),
  }).strict().nullable(),
  permissions: z.object({ remove: z.boolean() }).strict(),
}).strict();
export type MemberAccessRow = z.infer<typeof accessRow>;
