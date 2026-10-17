import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';
import { egressDestinationDataSchema } from './egress.ts';

const id = z.string().regex(/^[\w:.-]{1,300}$/u);
const count = z.int().nonnegative();
const closeFields = z.object({
  permitId: id, host: egressDestinationDataSchema.shape.host,
  port: z.int().min(1).max(65535), address: z.union([z.ipv4(), z.ipv6()]).nullable(),
  reason: z.enum(['finished', 'failed', 'refused', 'expired', 'revoked', 'unavailable']),
  bytesSent: count, bytesReceived: count, registeredAt: count,
  connectedAt: count.nullable(), closedAt: count,
}).strict();
export const egressCloseSchema = closeFields.refine(validTimes);
function validTimes(record: z.infer<typeof closeFields>) {
  if (record.closedAt < record.registeredAt) {
    return false;
  }
  if (record.connectedAt === null) {
    return record.bytesSent === 0 && record.bytesReceived === 0;
  }
  return record.address !== null && record.connectedAt >= record.registeredAt &&
    record.connectedAt <= record.closedAt;
}
export const legacyEgressObservationSchema = z.object({
  requestId: id, permitId: id, channel: z.enum(['command', 'desktop']),
  destinationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(['success', 'error', 'unknown']),
}).strict();
const observationFields = legacyEgressObservationSchema.extend({
  observationId: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(['error', 'unknown']), relay: egressCloseSchema,
});
export const egressObservationSchema = observationFields.refine(matchesPermit);
function matchesPermit(data: z.infer<typeof observationFields>) {
  return data.permitId === data.relay.permitId;
}
export function egressObservationId(silo: string, permitId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([silo, permitId, 'tunnel-close']));
  return bytesToHex(sha256(bytes));
}
export function validEgressObservation(event: EventEnvelope) {
  if (event.type !== 'egress.observed') {
    return true;
  }
  const modern = egressObservationSchema.safeParse(event.data);
  if (!modern.success) {
    return legacyEgressObservationSchema.safeParse(event.data).success;
  }
  const id = egressObservationId(event.silo, modern.data.permitId);
  return event.id === id && event.commandId === id && event.subject === `egress-${modern.data.requestId}` &&
    modern.data.observationId === id && event.source === 'models' &&
    event.principal?.kind === 'system' && event.principal.id === 'models';
}
