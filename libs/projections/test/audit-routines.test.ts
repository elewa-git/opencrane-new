import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import { auditTrail, readAudit } from '../src/audit.ts';
import { ProjectionRunner } from '../src/runner.ts';
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
  return z.record(z.string(), z.unknown()).parse(definition.example);
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
    const uncertain = routineEvent('routine.run_send_release_authorised', 'release-one',
      example('routine.run_send_release_authorised'));
    const laterStop = routineEvent('routine.run_stop_requested', 'stop-two',
      { ...example('routine.run_stop_requested'), actorId: 'bob' });
    await auditTrail.apply(db.db, due, 1);
    await auditTrail.apply(db.db, send, 2);
    expect((await readAudit(db.db, silo, { family: 'routines' })).rows[0]
      ?.records[0]?.routineState).toBe('prepared');
    await auditTrail.apply(db.db, stop, 3);
    await auditTrail.apply(db.db, uncertain, 4);
    await auditTrail.apply(db.db, laterStop, 5);
    await auditTrail.apply(db.db, stop, 3);
    const key = (await db.db.query<{ request_id: string }>(
      'SELECT request_id FROM audit_entries WHERE event_id = $1', [due.id])).rows[0]!.request_id;
    await db.db.query(`INSERT INTO audit_entries
      (silo, event_id, position, anchor, request_id, metadata, event_type)
      VALUES ($1, $2, $3, FALSE, $4, $5, $6)`,
    [silo, 'unrelated', 6, key, JSON.stringify({ eventId: 'unrelated',
      type: 'decision.recorded', position: 6, source: 'decision', status: 'recorded' }),
    'decision.recorded']);
    const page = await readAudit(db.db, silo, { family: 'routines' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.records.map(record => record.type)).toEqual([
      'routine.due', 'routine.run_send_authorised', 'routine.run_stop_requested',
      'routine.run_send_release_authorised', 'routine.run_stop_requested',
    ]);
    expect(page.rows[0]?.records[0]?.routineState).toBe('stop_requested');
    expect(page.rows[0]?.outcome).toBe('unknown');
    expect(page.rows[0]?.records[2]?.actor).toEqual({ kind: 'person', id: 'alice' });
    expect(page.rows[0]?.records[4]?.actor).toEqual({ kind: 'person', id: 'bob' });
    expect(page.rows[0]?.id).not.toBe(stop.id);
    expect(page.rows[0]?.id).not.toBe(send.id);
    expect(page.rows[0]?.id).not.toBe(uncertain.id);
    expect((await readAudit(db.db, silo, { reference: stop.id })).rows).toEqual([]);
    expect((await readAudit(db.db, silo, { reference: page.rows[0]!.id })).rows)
      .toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
    expect(JSON.stringify(page)).not.toContain('orders:read');
  } finally {
    await db.close();
  }
});

it('shows a completed outcome only with a saved result and settlement at finish', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    const due = routineEvent('routine.due', 'due-result', example('routine.due'));
    await auditTrail.apply(db.db, due, 1);
    const pending = routineEvent('routine.run_finished', 'finish-pending', {
      ...example('routine.run_finished'), outcome: 'succeeded',
      resultReference: { eventId: 'result', position: 8 },
    });
    await auditTrail.apply(db.db, pending, 2);
    expect((await readAudit(db.db, silo, { family: 'routines' })).rows[0]?.outcome)
      .not.toBe('success');
    const settled = routineEvent('routine.run_finished', 'finish-settled', {
      ...example('routine.run_finished'), outcome: 'succeeded',
      resultReference: { eventId: 'result', position: 8 }, settledCents: 17,
    });
    await auditTrail.apply(db.db, settled, 3);
    const page = await readAudit(db.db, silo, { family: 'routines' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.outcome).toBe('success');
    expect(page.rows[0]?.records[0]?.routineState).toBe('finished');
    expect(page.rows[0]?.records.at(-1)?.status).toBe('success');
    expect(page.rows[0]?.records[0]?.actor).toEqual({ kind: 'system', id: 'opencrane-server' });
    expect(page.rows[0]?.id).not.toBe(settled.id);
  } finally {
    await db.close();
  }
});

it('pages more than 50 occurrences without gaps after a new later receipt', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    const skipped = example('routine.occurrence_skipped');
    for (let index = 0; index < 55; index++) {
      const event = routineEvent('routine.occurrence_skipped', `skipped-${index}`,
        { ...skipped, occurrenceId: `slot-${index}` });
      await auditTrail.apply(db.db, event, index + 1);
    }
    const first = await readAudit(db.db, silo, { family: 'routines', limit: 50 });
    expect(first.rows).toHaveLength(50);
    const second = await readAudit(db.db, silo, {
      family: 'routines', limit: 50, before: first.nextBefore,
    });
    const all = [...first.rows, ...second.rows];
    expect(all).toHaveLength(55);
    expect(new Set(all.map(row => row.id)).size).toBe(55);
    expect(all.map(row => row.records[0]?.position)).toEqual(
      Array.from({ length: 55 }, (_, index) => 55 - index));
  } finally {
    await db.close();
  }
});

it('rebuilds the same rows from saved events', async () => {
  const db = await database('pg');
  const nats = await natsFixture();
  const runner = new ProjectionRunner(db.db, nats.store,
    createLogger('routine-audit-test', { level: 'silent' }));
  try {
    await runner.initialise(auditTrail);
    const due = routineEvent('routine.due', 'rebuild-due', example('routine.due'));
    const stopped = routineEvent('routine.run_stop_requested', 'rebuild-stop',
      { ...example('routine.run_stop_requested'), actorId: 'alice' });
    expect((await nats.store.append({ event: due, expectedSequence: 0 })).status)
      .toBe('appended');
    expect((await nats.store.append({ event: stopped, expectedSequence: 1 })).status)
      .toBe('appended');
    await runner.run(auditTrail);
    const before = await readAudit(db.db, silo, { family: 'routines' });
    await runner.rebuild(auditTrail);
    const after = await readAudit(db.db, silo, { family: 'routines' });
    expect(after).toEqual(before);
  } finally {
    await nats.close();
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
    expect(page.rows.map(row => row.records[0]?.status))
      .toEqual(['not_dispatched', 'not_dispatched']);
    expect(page.rows.every(row => row.records.every(record => !record.taskHref))).toBe(true);
  } finally {
    await db.close();
  }
});
