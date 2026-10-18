import { z } from 'zod';
import { decisionRecordedDataSchema, toolDispatchRecordedDataSchema } from '@opencrane/events';
import { envelope, history, type BudgetActor } from './actor.ts';

export const toolObservationSchema = z.object({
  id: z.uuid(), toolOutcome: z.enum(['not_dispatched', 'responded', 'outcome_unknown']),
  evidence: toolDispatchRecordedDataSchema.shape.evidence,
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
  const subject = `decision-${observation.id}`;
  const rows = await history(actor.store, subject, actor.silo);
  const decisionEvent = rows[0]?.event;
  if (decisionEvent?.type !== 'decision.recorded') return;
  const decision = decisionRecordedDataSchema.parse(decisionEvent.data);
  if (decision.route !== 'mcp' || decision.outcome !== 'allow' || !decision.logicalRequestId) {
    return;
  }
  const eventId = `${observation.id}:tool-dispatch`;
  function alreadyRecorded(row: typeof rows[number]) {
    return row.event.id === eventId;
  }
  if (rows.some(alreadyRecorded)) return;
  const lastEvent = rows.at(-1)?.event;
  const startId = `${observation.id}:tool-dispatch-started`;
  // Close only this saved start, including when its append reply was lost.
  if (observation.evidence === 'dispatch_refused' &&
      (lastEvent?.type !== 'tool.dispatch_started' || lastEvent.id !== startId)) {
    return;
  }
  const dispatchDetails = {
    conversationId: decision.conversationId, turnId: decision.turnId,
    callId: decision.callId, serverId: decision.serverId, toolName: decision.toolName,
    requestId: decision.requestId, logicalRequestId: decision.logicalRequestId,
    approvalId: decisionEvent.correlation.approval,
    outcome: observation.toolOutcome, evidence: observation.evidence,
    startedAt: decisionEvent.time, durationMs: observation.durationMs,
  };
  const data = toolDispatchRecordedDataSchema.parse(dispatchDetails);
  const event = envelope(actor.silo, subject, 'tool.dispatch_recorded', data, eventId);
  event.time = observation.observedAt;
  const command = { event, expectedSequence: rows.at(-1)!.sequence };
  const result = await actor.store.append(command);
  if (result.status !== 'appended') throw new Error('Tool dispatch evidence unavailable');
}
