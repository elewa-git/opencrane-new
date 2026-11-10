import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { auditTrail, readAudit } from '../src/audit.ts';
import { database } from './database.ts';

const silo = 'test';
const time = '2026-10-11T07:00:00Z';

function routineEvent(type: string, eventId: string, data: Record<string, unknown>): EventEnvelope {
  const actorId = typeof data['actorId'] === 'string' ? data['actorId'] : 'opencrane-server';
  const principal = { kind: actorId === 'opencrane-server' ? 'system' as const : 'human' as const,
    id: actorId };
  const candidate = { id: eventId, commandId: eventId, silo,
    subject: 'routine-orders', type, source: 'opencrane-server', time, principal,
    correlation: {}, data };
  const parsed = parseEventByType(candidate);
  if (!parsed.success) throw new Error(`Invalid fixture: ${parsed.reason}`);
  return parsed.event;
}

function example(type: string): Record<string, unknown> {
  const definition = getEventDefinition(type);
  if (!definition) throw new Error(`Missing ${type}`);
  return definition.example as Record<string, unknown>;
}

it('keeps one saved occurrence and its latest stop after a later uncertain send', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    const due = routineEvent('routine.due', 'due-one', example('routine.due'));
    const stop = routineEvent('routine.run_stop_requested', 'stop-one',
      { ...example('routine.run_stop_requested'), actorId: 'alice' });
    const send = routineEvent('routine.run_send_authorised', 'send-one',
      example('routine.run_send_authorised'));
    await auditTrail.apply(db.db, due, 1);
    await auditTrail.apply(db.db, stop, 2);
    await auditTrail.apply(db.db, send, 3);
    await auditTrail.apply(db.db, stop, 2);
    const page = await readAudit(db.db, silo, { family: 'routines' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.records.map(record => record.type)).toEqual([
      'routine.due', 'routine.run_stop_requested', 'routine.run_send_authorised',
    ]);
    expect(page.rows[0]?.records[0]?.routineState).toBe('stop_requested');
    expect(page.rows[0]?.outcome).toBe('unknown');
    expect(JSON.stringify(page)).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
    expect(JSON.stringify(page)).not.toContain('orders:read');
  } finally {
    await db.close();
  }
});

it('keeps skipped and missed work separate and gives neither a result link', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    await auditTrail.apply(db.db, routineEvent('routine.occurrence_skipped', 'skipped-one',
      example('routine.occurrence_skipped')), 1);
    await auditTrail.apply(db.db, routineEvent('routine.occurrences_missed', 'missed-one',
      example('routine.occurrences_missed')), 2);
    const page = await readAudit(db.db, silo, { family: 'routines' });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map(row => row.outcome)).toEqual(['not_dispatched', 'not_dispatched']);
    expect(page.rows.every(row => row.records.every(record => !record.taskHref))).toBe(true);
  } finally {
    await db.close();
  }
});
