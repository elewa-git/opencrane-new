import { z } from 'zod';
import { event } from './definition.ts';

const memberId = z.string().regex(/^[\w-]{1,200}$/u);
export const ownershipSeededSchema = z.object({
  ownerIds: z.array(memberId).min(1),
}).strict();
export const ownershipTransferredSchema = z.object({
  memberId, transferredBy: memberId, awaitingConfirmation: z.literal(true).optional(),
}).strict();
export const ownershipSteppedDownSchema = z.object({ memberId }).strict();

export const ownershipConfirmedSchema = z.object({ memberId, appointmentId: memberId }).strict();

export const ownershipEvents = [
  event('member.ownership_confirmed', 'member', 'An active member became a confirmed owner.',
    ownershipConfirmedSchema, { memberId: 'bob', appointmentId: 'appointment-bob' }),
  event('ownership.seeded', 'ownership', 'The current owners were seeded under a migration fence.',
    ownershipSeededSchema, { ownerIds: ['alice'] }),
  event('ownership.transferred', 'ownership', 'An owner requested an appointment and retained ownership.',
    ownershipTransferredSchema, { memberId: 'bob', transferredBy: 'alice' }),
  event('ownership.stepped_down', 'ownership', 'An owner became an Admin while another owner remained.',
    ownershipSteppedDownSchema, { memberId: 'alice' }),
];
