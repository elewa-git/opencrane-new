import { z } from 'zod';

const checkedGrant = z.enum(['allowed', 'denied', 'unavailable']);
const source = z.object({
  kind: z.enum(['direct', 'group']), groupId: z.string().optional(),
  granteeKind: z.string().optional(), granteeId: z.string().optional(),
  groupName: z.string().optional(), eventId: z.string(), sequence: z.int().positive(),
}).strict();
const accessRow = z.object({
  resourceType: z.string(), resourceId: z.string(), label: z.string().optional(),
  relation: z.enum(['use', 'acts_for']), sources: z.array(source),
  eligibility: z.object({
    person: checkedGrant,
    assistants: z.array(z.object({ assistantId: z.string(), grant: checkedGrant }).strict()),
    availability: z.literal('unavailable'),
  }).strict(),
}).strict();
export const memberAccessSchema = z.object({
  checkedAt: z.iso.datetime(), complete: z.boolean(), unavailableSections: z.array(z.string()),
  rows: z.array(accessRow),
}).strict();
const versionAbsence = z.object({
  status: z.enum(['absent_on_version', 'unsupported_history']), message: z.string(),
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
