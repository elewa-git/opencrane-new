import { z } from 'zod';

const memberId = z.string().regex(/^[\w-]{1,200}$/u);
export const memberPageQuerySchema = z.object({
  after: memberId.or(z.literal('')).default(''),
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const permissions = z.object({
  changeRole: z.literal(false),
  remove: z.literal(false),
  manageOwnership: z.boolean(),
}).strict();
export const memberHeaderSchema = z.object({
  memberId,
  displayName: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
  permissions,
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
  permissions,
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
  permissions: z.object({ invite: z.literal(false) }).strict(),
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
