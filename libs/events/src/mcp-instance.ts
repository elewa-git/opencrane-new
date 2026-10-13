import { z } from 'zod';
import { event } from './definition.ts';
import type { EventEnvelope } from './envelope.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.strictObject({ siloId: id, userId: id, profileId: id,
  serverId: id, startupAccessGeneration: z.int().positive() });

export const mcpInstanceStartSchema = identitySchema.extend({
  instanceId: digest, connectionId: id, imageDigest: digest,
  installGeneration: z.int().positive(), upstreamBindingDigest: digest,
  workloadSpecDigest: digest, runGeneration: z.int().positive(), changeRef: id,
  requestedAt: z.iso.datetime(), deadline: z.iso.datetime(),
});
export const mcpInstanceStopSchema = z.strictObject({
  instanceId: digest, runGeneration: z.int().positive(), startChangeRef: id,
  changeRef: id, expectedSequence: z.int().nonnegative(), requestedBy: id,
  reason: z.enum(['owner_stop', 'admin_stop']),
});
const observation = z.strictObject({
  instanceId: digest, runGeneration: z.int().positive(), startChangeRef: id,
  podUid: id, workloadSpecDigest: digest, expectedSequence: z.int().nonnegative().optional(),
  state: z.enum(['starting', 'failed', 'stopping', 'absent', 'unknown']),
  reason: z.enum(['startup_failed', 'not_found', 'transport_unavailable']).optional(),
});
function missingIsUnknown(data: z.infer<typeof observation>) {
  return data.reason !== 'not_found' || data.state === 'unknown';
}
export const mcpInstanceObservedSchema = observation.refine(missingIsUnknown);

export function validMcpInstanceEvent(event: EventEnvelope): boolean {
  const identity = z.object({ instanceId: digest }).safeParse(event.data);
  if (!identity.success) return false;
  if (event.subject !== `mcp-instance-${identity.data.instanceId}`) return false;
  if (event.type === 'mcp.instance_start_requested') {
    const result = mcpInstanceStartSchema.safeParse(event.data);
    if (!result.success) return false;
    const start = result.data;
    const duration = Date.parse(start.deadline) - Date.parse(start.requestedAt);
    return start.siloId === event.silo && duration > 0 && duration <= 20_000;
  }
  if (event.type === 'mcp.instance_stop_requested') {
    const result = mcpInstanceStopSchema.safeParse(event.data);
    if (!result.success) return false;
    const stop = result.data;
    return event.principal?.kind === 'human' && event.principal.id === stop.requestedBy;
  }
  const observed = mcpInstanceObservedSchema.safeParse(event.data);
  if (!observed.success) return false;
  return observed.data.expectedSequence === undefined ||
    (event.principal?.kind === 'system' && event.commandId !== undefined);
}

const key = { siloId: 'silo_1', userId: 'member_1', profileId: 'profile_1',
  serverId: 'server_1', startupAccessGeneration: 1 };
const instanceId = 'f881c4329e9b65a9d225a3598a1f5a0f572307d8c8e1e3884528802df17f3523';
const startExample = { ...key, instanceId, connectionId: 'connection_1',
  imageDigest: 'a'.repeat(64), installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64),
  workloadSpecDigest: 'c'.repeat(64), runGeneration: 1, changeRef: 'start_1',
  requestedAt: '2026-10-11T12:00:00Z', deadline: '2026-10-11T12:00:20Z' };
const observedExample = { instanceId, runGeneration: 1, startChangeRef: 'start_1',
  podUid: 'pod_1', workloadSpecDigest: startExample.workloadSpecDigest,
  state: 'starting' as const };
const stopExample = { instanceId, runGeneration: 1, startChangeRef: 'start_1',
  changeRef: 'stop_1', expectedSequence: 1, requestedBy: 'member_1',
  reason: 'owner_stop' as const };
export const mcpInstanceEvents = [
  event('mcp.instance_start_requested', 'mcp-instance', 'An instance start was requested.',
    mcpInstanceStartSchema, startExample),
  event('mcp.instance_observed', 'mcp-instance', 'A worker recorded an exact instance run.',
    mcpInstanceObservedSchema, observedExample),
  event('mcp.instance_stop_requested', 'mcp-instance', 'An owner or admin requested a stop.',
    mcpInstanceStopSchema, stopExample),
];
