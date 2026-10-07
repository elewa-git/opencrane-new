import { z } from 'zod';

const memberId = z.string().regex(/^[\w-]{1,200}$/u);

export const ownershipOwnerSchema = z.object({
  memberId,
  displayName: z.string(),
  role: z.literal('owner'),
});

export const ownershipResponseSchema = z.object({
  status: z.literal('current'),
  owners: z.array(ownershipOwnerSchema),
  sequence: z.number().int().nonnegative(),
  viewer: z.object({ memberId, role: z.enum(['owner', 'admin']) }),
  ready: z.boolean(),
});

export const ownershipCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('transfer'),
    commandId: memberId,
    expectedSequence: z.number().int().nonnegative(),
    successorId: memberId,
  }).strict(),
  z.object({
    action: z.literal('step_down'),
    commandId: memberId,
    expectedSequence: z.number().int().nonnegative(),
  }).strict(),
]);

export const ownershipChangeSchema = z.object({
  status: z.literal('appended'),
  commandId: memberId,
  changeId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  recordedAt: z.string().datetime({ offset: true }),
  actorId: memberId.optional(),
  type: z.enum(['ownership.transferred', 'ownership.stepped_down']),
  data: z.record(z.string(), z.unknown()),
  projection: z.object({
    content: z.enum(['current', 'applying']),
    iam: z.enum(['current', 'applying']),
  }).optional(),
});

export type OwnershipOwner = z.infer<typeof ownershipOwnerSchema>;
export type OwnershipResponse = z.infer<typeof ownershipResponseSchema>;
export type OwnershipCommand = z.infer<typeof ownershipCommandSchema>;
export type OwnershipChange = z.infer<typeof ownershipChangeSchema>;
