import { z } from 'zod';
import { event } from './definition.ts';

const id = z.string().min(1).max(200);
const refusalId = z.string().regex(/^[\w-]{1,200}$/u);
export const takeoverRefusedDataSchema = z.object({
  attemptId: refusalId, actorId: refusalId, conversationId: refusalId,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.enum(['requester_only', 'control_conflict']),
}).strict();
const refusedExample = { attemptId: 'attempt_1', actorId: 'member_1', conversationId: 'conv_1',
  inputDigest: 'a'.repeat(64), reason: 'requester_only' as const };
const refused = event('takeover.refused', 'view',
  'An authenticated control attempt was refused. Existing work and control are unchanged.',
  takeoverRefusedDataSchema, refusedExample);
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
export const takeoverPausingDataSchema = takeoverRequestedDataSchema.pick({
  assistantId: true, computerId: true, generation: true, podUid: true,
  takeoverId: true, affectedTurnIds: true,
}).extend({ affectedTurnIds: z.array(id).max(64), bridgeEpoch: id, supervisorEpoch: id,
  executionProof: z.literal('exited'), quietProof: z.literal('unavailable') }).strict();
const pausingExample = { assistantId: 'asst_1', computerId: 'computer_1', generation: 1,
  podUid: 'pod_1', takeoverId: 'control_1', affectedTurnIds: ['turn_1'],
  bridgeEpoch: 'bridge_1', supervisorEpoch: 'supervisor_1',
  executionProof: 'exited' as const, quietProof: 'unavailable' as const };
const pausing = event('takeover.pausing', 'computer',
  'The bridge denied work and the root supervisor confirmed executor exit. Control stays closed.',
  takeoverPausingDataSchema, pausingExample);
export const takeoverPausedDataSchema = takeoverPausingDataSchema.omit({
  executionProof: true,
}).extend({ quietProof: z.literal('complete') }).strict();
const { executionProof: _proof, ...pausedExample } = pausingExample;
const completeExample = { ...pausedExample, quietProof: 'complete' as const };
const paused = event('takeover.paused', 'computer',
  'The bridge and root supervisor proved quiet. Work and control stay closed.',
  takeoverPausedDataSchema, completeExample);
export const takeoverFailedDataSchema = takeoverPausingDataSchema.omit({
  bridgeEpoch: true, supervisorEpoch: true, executionProof: true, quietProof: true,
}).extend({ reason: z.literal('pause_timeout'),
  // Keep failures recordable when the request is too large for a signed gate.
  affectedTurnIds: takeoverRequestedDataSchema.shape.affectedTurnIds }).strict();
const { bridgeEpoch: _bridge, supervisorEpoch: _supervisor, quietProof: _quiet,
  ...failedExample } = pausedExample;
const timeoutExample = { ...failedExample, reason: 'pause_timeout' as const };
const failed = event('takeover.failed', 'computer',
  'The pause deadline expired. Work and control stay closed.',
  takeoverFailedDataSchema, timeoutExample);
export const takeoverEvents = [refused, requested, pausing, paused, failed];
