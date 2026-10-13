/// <reference lib="dom" />
import { z } from 'zod';
import { event } from './definition.ts';
import { eventEnvelopeSchema } from './envelope.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const reference = z.strictObject({ scopeId: digest, memoryId: identifier,
  revision: z.int().positive() });
const position = z.strictObject({ scopeId: digest, position: z.int().nonnegative() });
const recordSchema = z.strictObject({
  conversationId: identifier, turnId: identifier, requesterId: identifier,
  assistantId: identifier, computerId: identifier, generation: z.int().positive(),
  threadId: identifier, inputGeneration: identifier,
  action: z.enum(['prepared', 'loaded', 'invalidated', 'ended']),
  delivery: z.enum(['initial', 'recall']).nullable(),
  callDigest: digest.nullable(), dispatchDigest: digest.nullable(),
  additions: z.array(reference).max(32), scopePositions: z.array(position).max(3),
  projectionGeneration: identifier, byteCount: z.int().min(0).max(16384),
  hasOmissions: z.boolean(),
  reason: z.enum(['none', 'content_changed', 'access_changed', 'expired', 'ended', 'unavailable']),
});
export type MemoryContextRecord = z.infer<typeof recordSchema>;
export const memoryContextRecordedDataSchema = recordSchema.refine(validAction);

function validLoad(data: MemoryContextRecord) {
  const recall = data.delivery === 'recall';
  return data.delivery !== null && data.reason === 'none' &&
    (!recall || data.additions.length <= 20) &&
    (data.callDigest !== null) === recall && (data.dispatchDigest !== null) === recall;
}
function validAction(data: MemoryContextRecord) {
  if (data.action === 'loaded') {
    return validLoad(data);
  }
  if (data.delivery !== null || data.callDigest !== null || data.dispatchDigest !== null ||
      data.additions.length !== 0 || data.byteCount !== 0 || data.hasOmissions) {
    return false;
  }
  if (data.action === 'prepared') {
    return data.reason === 'none';
  }
  if (data.action === 'ended') {
    return data.reason === 'ended';
  }
  return data.reason !== 'none' && data.reason !== 'ended';
}
const envelope = eventEnvelopeSchema(memoryContextRecordedDataSchema);
const encoder = new TextEncoder();
function validWriter(saved: z.infer<typeof envelope>) {
  const bytes = encoder.encode(JSON.stringify(saved));
  return saved.type === 'agent.memory_context_recorded' &&
    saved.subject === `conversation-${saved.data.conversationId}` &&
    saved.source === 'opencrane-server' && saved.report === undefined && bytes.byteLength <= 16384;
}
export const memoryContextRecordedEventSchema = envelope.refine(validWriter);
const example: MemoryContextRecord = { conversationId: 'chat', turnId: 'turn',
  requesterId: 'alice', assistantId: 'assistant', computerId: 'computer', generation: 1,
  threadId: 'thread', inputGeneration: 'context', action: 'prepared', delivery: null,
  callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
  projectionGeneration: 'projection', byteCount: 0, hasOmissions: false, reason: 'none' };
export const memoryContextEvent = event('agent.memory_context_recorded', 'conversation',
  'The server recorded memory references for one private turn without saving text.',
  memoryContextRecordedDataSchema, example);
