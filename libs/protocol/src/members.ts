import { z } from 'zod';

const memberId = z.string().regex(/^[\w-]{1,200}$/u);
export const memberPageQuerySchema = z.object({
  after: memberId.or(z.literal('')).default(''),
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const headerPermissions = z.object({
  changeRole: z.literal(false),
  remove: z.literal(false),
  manageOwnership: z.boolean(),
}).strict();
const managementPermissions = headerPermissions.extend({
  changeRole: z.boolean(), remove: z.boolean(),
}).strict();
export const memberHeaderSchema = z.object({
  memberId,
  displayName: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  permissions: headerPermissions,
}).strict();
const group = z.object({
  groupId: memberId,
  name: z.string(),
  membershipSource: z.enum(['local', 'identity_provider']),
}).strict();
export const memberDirectoryRowSchema = memberHeaderSchema.omit({ permissions: true }).extend({
  email: z.string(),
  status: z.literal('joined'),
  joinedAt: z.iso.datetime(),
  groups: z.array(group).max(100),
}).strict();
export const memberDetailSchema = memberDirectoryRowSchema.extend({
  permissions: managementPermissions,
  memberSequence: z.int().nonnegative(),
  ownershipSequence: z.int().nonnegative(),
  personalAssistant: z.object({ status: z.literal('unavailable') }).strict(),
  rejoinedAt: z.object({ status: z.literal('unavailable') }).strict(),
}).strict();
const count = z.object({
  status: z.enum(['current', 'applying', 'unavailable']),
  value: z.int().nonnegative().nullable(),
}).strict();
export const memberDirectorySchema = z.object({
  rows: z.array(memberDirectoryRowSchema).max(50),
  next: memberId.nullable(),
  counts: z.object({
    members: count, groups: count, pendingInvitations: count, acceptedInvitations: count,
  }).strict(),
  checkedAt: z.iso.datetime(),
  projection: z.object({ content: z.enum(['current', 'applying']) }).strict(),
  permissions: z.object({ invite: z.boolean() }).strict(),
}).strict();

export const invitationEmailInputSchema = z.object({ email: z.email().max(254) }).strict();
export const invitationEmailSchema = z.object({
  status: z.literal('confirmation_on_acceptance'),
  email: z.email().max(254),
  message: z.literal('The person is confirmed when they accept the invitation.'),
}).strict();

function normaliseEmail(value: string) {
  return value.trim().toLowerCase();
}
const invitationAddress = z.string().trim().max(254).regex(/^[\x20-\x7e]+$/u)
  .transform(normaliseEmail).pipe(z.email());
export const invitationCommandSchema = z.object({
  commandId: memberId,
  memberId,
  email: invitationAddress,
  expectedSequence: z.int().nonnegative(),
  role: z.enum(['member', 'admin']),
  personalAssistant: z.enum(['provision', 'none']),
}).strict();
export const invitationStatusParamsSchema = z.object({ memberId, commandId: memberId }).strict();

export const invitationChangeSchema = z.object({
  status: z.enum(['recorded', 'refused', 'not_found']),
  commandId: memberId,
  changeId: memberId.optional(),
  type: z.enum(['member.invited', 'member.command_refused']).optional(),
  sequence: z.int().positive().optional(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
  reason: z.string().max(100).optional(),
  projection: z.object({ content: z.enum(['current', 'applying']),
    iam: z.literal('not_required') }).strict().optional(),
  result: z.object({
    status: z.literal('appended'), memberId, invitationId: memberId,
    sequence: z.int().positive(), createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(), email: z.email(),
    role: z.enum(['owner', 'admin', 'member']),
    personalAssistant: z.enum(['provision', 'none']), delivery: z.literal('link_only'),
    link: z.url(),
  }).strict().optional(),
}).strict();
