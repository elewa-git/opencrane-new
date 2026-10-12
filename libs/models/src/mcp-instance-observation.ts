import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mcpInstanceStartSchema, mcpInstanceObservedSchema,
  type EventEnvelope } from '@opencrane/events';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { applyMcpInstance, type McpInstanceState } from '@opencrane/projections';
import { McpInstanceRefused, readMcpInstance } from './mcp-instance.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const registrationSchema = mcpInstanceStartSchema.pick({ instanceId: true, siloId: true,
  userId: true, profileId: true, serverId: true, startupAccessGeneration: true,
  runGeneration: true, workloadSpecDigest: true }).extend({
  startChangeRef: id, podUid: id, workerId: id, expectedSequence: z.int().nonnegative(),
});
type Registration = z.infer<typeof registrationSchema>;
const observationSchema = z.strictObject({ changeRef: id,
  expectedSequence: z.int().nonnegative(),
  state: z.enum(['starting', 'failed', 'stopping', 'absent', 'unknown']),
  reason: z.enum(['startup_failed', 'not_found', 'transport_unavailable']).optional(),
});

function checkWorker(silo: string, worker: Registration, state: McpInstanceState) {
  const start = state.start;
  if (silo !== worker.siloId || start.userId !== worker.userId ||
      start.startupAccessGeneration !== worker.startupAccessGeneration ||
      start.runGeneration !== worker.runGeneration || start.changeRef !== worker.startChangeRef ||
      start.workloadSpecDigest !== worker.workloadSpecDigest ||
      (state.podUid !== undefined && state.podUid !== worker.podUid) ||
      state.phase === 'sleeping') {
    throw new McpInstanceRefused('conflict', 'Worker instance mismatch');
  }
}

export async function mcpInstanceWorkerRegistration(store: EventStore, silo: string, raw: unknown) {
  const worker = registrationSchema.parse(raw);
  const reference = { instanceId: worker.instanceId, profileId: worker.profileId,
    serverId: worker.serverId };
  const { state } = await readMcpInstance(store, silo, reference);
  checkWorker(silo, worker, state);
  if (state.sequence !== worker.expectedSequence) {
    throw new McpInstanceRefused('conflict', 'Worker revision mismatch');
  }
  return worker;
}

function checkSavedObservation(saved: StoredEvent, attempted: EventEnvelope) {
  const event = saved.event;
  if (event.silo !== attempted.silo || event.subject !== attempted.subject ||
      event.type !== attempted.type || event.commandId !== attempted.commandId ||
      event.principal?.kind !== 'system' || event.principal.id !== attempted.principal?.id) {
    throw new McpInstanceRefused('conflict', 'Observation payload mismatch');
  }
  const savedData = mcpInstanceObservedSchema.parse(event.data);
  const attemptedData = mcpInstanceObservedSchema.parse(attempted.data);
  if (JSON.stringify(savedData) !== JSON.stringify(attemptedData)) {
    throw new McpInstanceRefused('conflict', 'Observation payload mismatch');
  }
  return { status: 'applied' as const, sequence: saved.sequence,
    runGeneration: savedData.runGeneration };
}

export async function mcpInstanceObservation(store: EventStore, silo: string,
  worker: Registration, permission: { expiresAt: number; signal: AbortSignal }, raw: unknown) {
  const input = observationSchema.parse(raw);
  const observation = { instanceId: worker.instanceId,
    runGeneration: worker.runGeneration, startChangeRef: worker.startChangeRef,
    podUid: worker.podUid, workloadSpecDigest: worker.workloadSpecDigest,
    expectedSequence: input.expectedSequence, state: input.state, reason: input.reason };
  const data = mcpInstanceObservedSchema.parse(observation);
  const reference = { instanceId: worker.instanceId, profileId: worker.profileId,
    serverId: worker.serverId };
  const current = await readMcpInstance(store, silo, reference);
  checkWorker(silo, worker, current.state);
  const event: EventEnvelope = { id: randomUUID(), commandId: input.changeRef, silo,
    subject: `mcp-instance-${worker.instanceId}`, type: 'mcp.instance_observed', data,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'system', id: worker.workerId } };
  function sameChange(row: StoredEvent) {
    return row.event.commandId === input.changeRef;
  }
  const original = current.rows.find(sameChange);
  // Refuse expired or replaced passes after reading saved history.
  if (permission.signal.aborted || Date.now() >= permission.expiresAt) {
    throw new McpInstanceRefused('conflict', 'Worker expired or replaced');
  }
  if (original) return checkSavedObservation(original, event);
  if (input.expectedSequence !== current.state.sequence) {
    throw new McpInstanceRefused('conflict', 'Observation revision mismatch');
  }
  try {
    applyMcpInstance(current.state, event, current.state.sequence + 1);
  } catch {
    throw new McpInstanceRefused('conflict', 'Observation does not match the saved run');
  }
  const command = { event, expectedSequence: current.state.sequence, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'conflict') {
    throw new McpInstanceRefused('conflict', 'Observation revision mismatch');
  }
  if (result.status !== 'appended') throw new Error('Observation append unconfirmed');
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) throw new Error('Saved observation unavailable');
  return checkSavedObservation(saved, event);
}
