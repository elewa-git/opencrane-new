import { z } from 'zod';
import { event } from './definition.ts';

const id = z.string().min(1).max(200);
export const takeoverRequestedDataSchema = z.object({
  assistantId: id, computerId: id, generation: z.int().positive(), podUid: id,
  conversationId: id, requesterId: id, requesterEventId: id, takeoverId: id, leaseId: id,
  reason: z.literal('requester_requested'), affectedTurnIds: z.array(id).max(10_000),
}).strict();
const example = {
  assistantId: 'asst_1', computerId: 'computer_1', generation: 1, podUid: 'pod_1',
  conversationId: 'conv_1', requesterId: 'mem_1', requesterEventId: 'msg_1',
  takeoverId: 'control_1', leaseId: 'lease_1', reason: 'requester_requested' as const,
  affectedTurnIds: ['turn_1'],
};
const requested = event('takeover.requested', 'computer',
  'The requester recorded computer-wide control intent. New work is refused.',
  takeoverRequestedDataSchema, example);
export const takeoverEvents = [requested];
