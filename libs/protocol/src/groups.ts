import { z } from 'zod';

const id = z.string().regex(/^[\w-]{1,200}$/u);
function hasNoNul(value: string): boolean {
  return !value.includes('\0');
}
const grantSchema = z.object({
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  relation: z.enum(['use', 'acts_for']),
});
const memberSchema = z.object({
  memberId: id,
  displayName: z.string().min(1),
  membershipSource: z.enum(['local', 'identity_provider']),
});
export const groupRowSchema = z.object({
  groupId: id,
  name: z.string().min(1),
  membershipSource: z.enum(['local', 'identity_provider']),
  position: z.int().nonnegative(),
  payingGroupId: id,
  members: z.array(memberSchema),
  access: z.object({
    source: z.literal('group_membership'),
    // Refuse rows that claim group membership can reveal private conversations or memory.
    conversationAccess: z.literal(false),
    personalMemoryAccess: z.literal(false),
    grants: z.array(grantSchema),
  }),
});
export const groupsResponseSchema = z.object({ rows: z.array(groupRowSchema) });
export const groupReceiptSchema = z.object({
  status: z.literal('appended'),
  groupId: id,
  sequence: z.int().nonnegative(),
  changeId: z.string().min(1),
});
export const groupChangeSchema = groupReceiptSchema.extend({
  projection: z.object({ content: z.enum(['current', 'applying']), iam: z.enum(['current', 'applying']) }),
});
export const createGroupCommandSchema = z.object({
  commandId: id,
  groupId: id,
  name: z.string().trim().min(1).max(200).refine(hasNoNul),
}).strict();
export type GroupRow = z.infer<typeof groupRowSchema>;
