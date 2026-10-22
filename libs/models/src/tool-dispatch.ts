import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { decisionRecordedDataSchema, toolDispatchRecordedDataSchema, type EventEnvelope } from '@opencrane/events';
import { envelope, history, type BudgetActor } from './actor.ts';

export const toolObservationSchema = z.object({
  id: z.uuid(), toolOutcome: z.enum(['not_dispatched', 'responded', 'outcome_unknown']),
  evidence: z.enum([
    'connection_refused', 'dispatch_refused', 'response_received', 'transport_uncertain',
  ]),
  observedAt: z.iso.datetime(), durationMs: z.int().nonnegative(),
}).strict();

function durationMilliseconds(line: string) {
  const duration = /\bduration=(\d+(?:\.\d+)?)(ns|µs|ms|s)(?=\s|$)/u.exec(line);
  if (!duration) return undefined;
  const scales: Record<string, number> = { ns: 0.000001, µs: 0.001, ms: 1, s: 1000 };
  const milliseconds = Math.ceil(Number(duration[1]) * scales[duration[2]!]!);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  return milliseconds;
}

export function toolObservation(line: string) {
  if (!/\broute=default\/mcp-/u.test(line)) return;
  const id = z.uuid().safeParse(/\btoolRequestId="([^"]+)"/u.exec(line)?.[1]);
  const observedAt = z.iso.datetime().safeParse(line.split(/\s/u)[0]);
  const durationMs = durationMilliseconds(line);
  if (!id.success || !observedAt.success || durationMs === undefined) return;
  let toolOutcome: 'not_dispatched' | 'responded' | 'outcome_unknown' = 'outcome_unknown';
  let evidence: 'connection_refused' | 'response_received' | 'transport_uncertain' =
    'transport_uncertain';
  // Accept only the pinned gateway's refused TCP connection, before any HTTP bytes can leave.
  if (line.includes('error="upstream call failed: Connect: Connection refused (os error 111)"')) {
    toolOutcome = 'not_dispatched';
    evidence = 'connection_refused';
  } else if (!/\berror=/u.test(line) && /\bhttp.status=\d{3}(?=\s|$)/u.test(line)) {
    toolOutcome = 'responded';
    evidence = 'response_received';
  }
  return { id: id.data, toolOutcome, evidence, observedAt: observedAt.data,
    durationMs };
}

export async function recordToolObservation(actor: BudgetActor,
  observation: z.infer<typeof toolObservationSchema>) {
  await recordObservation(actor, toolObservationSchema.parse(observation));
}

type AdapterBinding = NonNullable<z.infer<typeof toolDispatchRecordedDataSchema>['adapter']>;
type Observation = Omit<z.infer<typeof toolObservationSchema>, 'evidence'> & {
  evidence: z.infer<typeof toolDispatchRecordedDataSchema>['evidence'];
};

export async function recordAdapterObservation(actor: BudgetActor,
  binding: AdapterBinding & { silo: string }, observation: Observation) {
  if (binding.silo !== actor.silo) throw new Error('Tool dispatch evidence unavailable');
  const { silo: _silo, ...adapter } = binding;
  await recordObservation(actor, observation, adapter);
}

async function recordObservation(actor: BudgetActor, observation: Observation,
  adapter?: AdapterBinding) {
  const subject = `decision-${observation.id}`;
  const rows = await history(actor.store, subject, actor.silo);
  const context = observationContext(rows, observation, adapter);
  if (!context) return;
  const { decisionEvent, decision, start } = context;
  const eventId = `${observation.id}:tool-dispatch`;
  function alreadyRecorded(row: typeof rows[number]) {
    return row.event.id === eventId;
  }
  const recorded = rows.find(alreadyRecorded);
  if (recorded) {
    if (adapter) requireSameAdapter(recorded.event, observation, adapter);
    return;
  }
  const lastEvent = rows.at(-1)?.event;
  const startId = `${observation.id}:tool-dispatch-started`;
  // Close only this saved start, including when its append reply was lost.
  const refused = observation.evidence === 'dispatch_refused' ||
    observation.evidence === 'adapter_dispatch_refused';
  if (refused &&
      (lastEvent?.type !== 'tool.dispatch_started' || lastEvent.id !== startId)) {
    return;
  }
  const dispatchDetails = {
    conversationId: decision.conversationId, turnId: decision.turnId,
    callId: decision.callId, serverId: decision.serverId, toolName: decision.toolName,
    requestId: decision.requestId, logicalRequestId: decision.logicalRequestId,
    approvalId: decisionEvent.correlation.approval,
    outcome: observation.toolOutcome, evidence: observation.evidence,
    startedAt: adapter ? start!.time : decisionEvent.time, durationMs: observation.durationMs,
    ...(adapter ? { adapter } : {}),
  };
  const data = toolDispatchRecordedDataSchema.parse(dispatchDetails);
  const event = envelope(actor.silo, subject, 'tool.dispatch_recorded', data, eventId);
  event.time = observation.observedAt;
  const command = { event, expectedSequence: rows.at(-1)!.sequence };
  try {
    const result = await actor.store.append(command);
    if (result.status === 'appended') return;
  } catch {
    // Read the original record after a lost save reply. Never send the tool again.
  }
  const savedRows = await history(actor.store, subject, actor.silo);
  const saved = savedRows.find(alreadyRecorded);
  if (!saved || JSON.stringify(saved.event.data) !== JSON.stringify(data)) {
    throw new Error('Tool dispatch evidence unavailable');
  }
}

function observationContext(rows: StoredEvent[], observation: Observation,
  adapter: AdapterBinding | undefined) {
  const decisionEvent = rows[0]?.event;
  if (decisionEvent?.type !== 'decision.recorded') {
    if (adapter) throw new Error('Tool dispatch evidence unavailable');
    return;
  }
  const decision = decisionRecordedDataSchema.parse(decisionEvent.data);
  if (decision.route !== 'mcp' || decision.outcome !== 'allow' || !decision.logicalRequestId) {
    if (adapter) throw new Error('Tool dispatch evidence unavailable');
    return;
  }
  function isStart(row: typeof rows[number]) {
    return row.event.type === 'tool.dispatch_started';
  }
  const start = rows.find(isStart)?.event;
  const startData = z.record(z.string(), z.unknown()).safeParse(start?.data);
  if (!adapter && startData.success && startData.data['adapter'] === 'remote_https') return;
  if (adapter) requireAdapterStart(decisionEvent, start, observation, adapter);
  return { decisionEvent, decision, start };
}

function requireAdapterStart(decision: EventEnvelope, start: EventEnvelope | undefined,
  observation: Observation, adapter: AdapterBinding) {
  const data = decisionRecordedDataSchema.parse(decision.data);
  const expectedStart = { requestId: observation.id, serverId: data.serverId,
    connectionId: adapter.connectionId, generation: adapter.generation,
    recordDigest: adapter.recordDigest, reviewRevision: adapter.reviewRevision,
    adapter: 'remote_https' };
  const startData = z.record(z.string(), z.unknown()).safeParse(start?.data);
  function differs([field, value]: [string, unknown]) {
    return !startData.success || startData.data[field] !== value;
  }
  const fields = Object.entries(expectedStart);
  if (decision.id !== adapter.decisionId || data.requestId !== observation.id ||
      start?.id !== adapter.startId || fields.some(differs)) {
    throw new Error('Tool dispatch evidence unavailable');
  }
}

function requireSameAdapter(event: EventEnvelope, observation: Observation,
  adapter: AdapterBinding) {
  const saved = toolDispatchRecordedDataSchema.parse(event.data);
  if (JSON.stringify(saved.adapter) !== JSON.stringify(adapter) ||
      saved.evidence !== observation.evidence || saved.outcome !== observation.toolOutcome) {
    throw new Error('Tool dispatch evidence unavailable');
  }
}
