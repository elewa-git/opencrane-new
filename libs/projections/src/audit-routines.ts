import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { AuditRecord, AuditRow } from '@opencrane/protocol';

const occurrenceTypes = new Set([
  'routine.due', 'routine.occurrence_skipped', 'routine.occurrences_missed',
  'routine.run_activation_admitted', 'routine.run_send_authorised',
  'routine.run_send_release_authorised', 'routine.run_stop_requested',
  'routine.run_finished',
]);

export function routineAuditData(event: EventEnvelope): Record<string, unknown> | undefined {
  if (!occurrenceTypes.has(event.type)) return undefined;
  const parsed = parseEventByType(event);
  if (!parsed.success) throw new Error('Invalid routine audit event');
  const data = z.record(z.string(), z.unknown()).parse(parsed.event.data);
  if (data['version'] !== 1) return undefined;
  const routineId = data['routineId'];
  if (typeof routineId !== 'string' || event.subject !== `routine-${routineId}`) {
    throw new Error('Invalid routine audit event');
  }
  return data;
}

export function routineReference(eventId: string): string {
  return createHash('sha256').update(eventId).digest('hex').slice(0, 32);
}

export function routineOccurrenceKey(event: EventEnvelope,
  data: Record<string, unknown>): string {
  let occurrenceId = data['occurrenceId'];
  if (event.type === 'routine.occurrences_missed') {
    const missed = z.object({ scheduleRevision: z.int().positive(),
      firstLocalDate: z.iso.date(), lastLocalDate: z.iso.date() }).parse(data);
    occurrenceId = `missed:${missed.scheduleRevision}:` +
      `${missed.firstLocalDate}:${missed.lastLocalDate}`;
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([event.silo, data['routineId'], occurrenceId]));
  return `routine:${hash.digest('hex')}`;
}

export function routineIsAnchor(type: string): boolean {
  return type === 'routine.due' || type === 'routine.occurrence_skipped' ||
    type === 'routine.occurrences_missed';
}

export function routineMetadata(event: EventEnvelope,
  data: Record<string, unknown>): Partial<AuditRecord> {
  if (event.type === 'routine.due') {
    return { routineState: 'due' };
  }
  if (event.type === 'routine.occurrence_skipped') {
    return { routineState: 'skipped' };
  }
  if (event.type === 'routine.occurrences_missed') {
    return { routineState: 'missed' };
  }
  if (event.type === 'routine.run_activation_admitted') {
    return { routineState: 'admitted' };
  }
  if (event.type === 'routine.run_send_authorised') {
    return { routineState: 'prepared' };
  }
  if (event.type === 'routine.run_stop_requested') {
    return { routineState: 'stop_requested' };
  }
  if (event.type === 'routine.run_finished') {
    return { routineState: 'finished',
      routineFinishOutcome: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted'])
        .parse(data['outcome']),
      routineSettled: data['resultReference'] !== undefined &&
        Number.isSafeInteger(data['settledCents']) };
  }
  return { routineState: 'send_uncertain' };
}

export function routineOutcome(records: AuditRecord[]): {
  state: NonNullable<AuditRecord['routineState']>; outcome: AuditRow['outcome'];
} {
  const start = records[0];
  if (start?.routineState === 'skipped' || start?.routineState === 'missed') {
    return { state: start.routineState, outcome: 'not_dispatched' };
  }
  const finished = records.findLast(record => record.type === 'routine.run_finished');
  if (finished) {
    if (finished.routineFinishOutcome === 'succeeded' && finished.routineSettled === true) {
      return { state: 'finished', outcome: 'success' };
    }
    if (finished.routineFinishOutcome === 'failed') {
      return { state: 'finished', outcome: 'error' };
    }
    return { state: 'finished', outcome: 'unknown' };
  }
  const stopped = records.some(record => record.type === 'routine.run_stop_requested');
  if (stopped) return { state: 'stop_requested', outcome: 'unknown' };
  const sent = records.some(record => record.routineState === 'send_uncertain');
  if (sent) return { state: 'send_uncertain', outcome: 'unknown' };
  const prepared = records.some(record => record.routineState === 'prepared');
  if (prepared) return { state: 'prepared', outcome: 'unknown' };
  const admitted = records.some(record => record.routineState === 'admitted');
  if (admitted) return { state: 'admitted', outcome: 'unknown' };
  return { state: 'due', outcome: 'unknown' };
}
