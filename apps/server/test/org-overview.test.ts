import { describe, expect, it, vi } from 'vitest';
import type { Query } from '@opencrane/projections';
import { buildOverview, type OverviewRow, type OverviewSource } from '../src/overview/rows.ts';
import { loadSource, memoryRow, providerRow, routineRow } from '../src/overview/routes.ts';

function row(source: OverviewRow['source'], id: string, priority: OverviewRow['priority'],
  time: string): OverviewRow {
  return { source, id, sourceId: id, priority, eventAt: time, revision: 1,
    action: 'view_evidence', href: '/api/org/overview' };
}

const old = '2026-01-01T00:00:00.000Z';
const recent = '2026-02-01T00:00:00.000Z';

function source(name: OverviewSource['name'], rows: OverviewRow[]): OverviewSource {
  return { name, status: 'current', checkpoint: 12, checkedAt: recent, rows };
}

function providerFact(outcome: string, time: string, revision = 2) {
  return { outcome, time, revision, changeId: `check-${outcome}-${time}` };
}

function providerWithChecks(reachable?: ReturnType<typeof providerFact>,
  modelAnswer?: ReturnType<typeof providerFact>) {
  const state: Parameters<typeof providerRow>[0]['state'] = {
    providerId: 'provider-one', revision: 2, position: 5,
  };
  if (reachable) state.reachable = reachable;
  if (modelAnswer) state.modelAnswer = modelAnswer;
  return providerRow({ state });
}

describe('organisation overview rows', () => {
  it('shows saved routine attention and requires a dated finish for Ready', () => {
    const reference = '7f6a9d0e4c329b817f6a9d0e4c329b81';
    const due = { public_id: reference, position: '7', recorded_at: old,
      outcome: 'unknown', finished_at: null, metadata: { routineState: 'due' } };
    expect(routineRow(due)?.priority).toBe('unknown');
    expect(routineRow({ ...due, latest_at: recent })?.eventAt).toBe(recent);
    expect(routineRow({ ...due, outcome: 'not_dispatched',
      metadata: { routineState: 'skipped' } })?.priority).toBe('failure');
    expect(routineRow({ ...due, outcome: 'success' })?.priority).toBe('unknown');
    const ready = routineRow({ ...due, outcome: 'success', finished_at: recent,
      metadata: { routineState: 'finished' } });
    expect(ready?.priority).toBe('ready');
    expect(ready?.eventAt).toBe(recent);
    expect(ready?.href).toBe(`/api/org/history/${reference}`);
    expect(() => routineRow({ ...due, public_id: 'routine-orders' }))
      .toThrow('Routine history unavailable');
  });

  it('keeps late and timed-out routine sources unavailable to Ready', async () => {
    const reference = '7f6a9d0e4c329b817f6a9d0e4c329b81';
    const saved = { public_id: reference, position: '7', recorded_at: old,
      outcome: 'success', finished_at: recent, metadata: { routineState: 'finished' } };
    const lateQuery = vi.fn().mockResolvedValueOnce({ rows: [{ sequence: '7' }] })
      .mockResolvedValueOnce({ rows: [saved] });
    const late = await loadSource('routines', { query: lateQuery }, 'test', 8, 100,
      'SELECT saved LIMIT 51', routineRow);
    expect(late.status).toBe('applying');
    const timeout = vi.fn().mockRejectedValue(new Error('timeout'));
    const unavailable = await loadSource('routines', { query: timeout }, 'test', 8, 100,
      'SELECT saved LIMIT 51', routineRow);
    expect(unavailable.status).toBe('unavailable');
    expect(unavailable.rows).toEqual([]);
  });

  it('keeps a saved night pending until a result and never calls a root Ready', () => {
    function savedNight(action: string) {
      return memoryRow({ public_id: '7f6a9d0e4c329b817f6a9d0e4c329b81',
        position: '5', recorded_at: recent,
        metadata: { maintenanceReference: '7f6a9d0e4c329b817f6a9d0e4c329b81',
          maintenanceAction: action } });
    }
    expect(savedNight('due')?.priority).toBe('unknown');
    expect(savedNight('prepared')?.priority).toBe('unknown');
    expect(savedNight('refused')?.priority).toBe('failure');
    expect(savedNight('missed')?.priority).toBe('failure');
    expect(savedNight('no_changes')).toBeNull();
    expect(memoryRow({ public_id: '8c2d4a6e5f109b738c2d4a6e5f109b73', position: '6',
      recorded_at: new Date(recent), metadata: {
        maintenanceReference: '8c2d4a6e5f109b738c2d4a6e5f109b73',
        maintenanceAction: 'prepared',
      } })?.eventAt)
      .toBe(recent);
  });

  it('rejects malformed memory metadata and never uses an original night id', () => {
    const reference = '7f6a9d0e4c329b817f6a9d0e4c329b81';
    const candidate = { public_id: reference, position: '5', recorded_at: recent,
      metadata: { maintenanceReference: reference, maintenanceAction: 'prepared' } };
    expect(memoryRow(candidate)?.id).toBe(reference);
    expect(memoryRow({ ...candidate, public_id: null })).toBeNull();
    expect(memoryRow({ ...candidate, public_id: 'night-one' })).toBeNull();
    expect(memoryRow({ ...candidate, metadata: { ...candidate.metadata,
      maintenanceAction: 'done' } })).toBeNull();
    expect(memoryRow({ ...candidate, metadata: { maintenanceAction: 'prepared' } }))
      .toBeNull();
  });

  it('limits each memory source to 50 and treats a 51st result as unavailable', async () => {
    const reference = '7f6a9d0e4c329b817f6a9d0e4c329b81';
    const saved = { public_id: reference, position: '5', recorded_at: recent,
      metadata: { maintenanceReference: reference, maintenanceAction: 'prepared' } };
    const records = Array(51).fill(saved);
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ sequence: '51' }] })
      .mockResolvedValueOnce({ rows: records });
    const source = await loadSource('memory', { query }, 'test', 51, 100,
      'SELECT saved LIMIT 51', memoryRow);
    expect(source.status).toBe('unavailable');
    expect(source.rows).toHaveLength(50);
  });

  it('reports a late or timed-out memory source while keeping other rows', async () => {
    const saved = { public_id: '7f6a9d0e4c329b817f6a9d0e4c329b81',
      position: '5', recorded_at: recent,
      metadata: { maintenanceReference: '7f6a9d0e4c329b817f6a9d0e4c329b81',
        maintenanceAction: 'prepared' } };
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ sequence: '5' }] })
      .mockResolvedValueOnce({ rows: [saved] });
    const db: Query = { query };
    const late = await loadSource('memory', db, 'test', 6, 100, 'SELECT saved', memoryRow);
    expect(late.status).toBe('applying');
    expect(late.rows[0]?.priority).toBe('unknown');

    const timeout = vi.fn().mockRejectedValue(new Error('timeout'));
    const unavailable = await loadSource('memory', { query: timeout },
      'test', 6, 100, 'SELECT saved', memoryRow);
    expect(unavailable.status).toBe('unavailable');
    const overview = buildOverview([source('people', [row('people', 'invite', 'needs_input', old)]),
      unavailable]);
    expect(overview.rows.map(item => item.id)).toEqual(['invite']);
    expect(overview.allClear).toBe(false);
  });
  it('requires current passing reachability and model checks before Ready', () => {
    const pass = providerFact('pass', old);
    const laterPass = providerFact('pass', recent);
    expect(providerWithChecks(pass).priority).toBe('needs_input');
    expect(providerWithChecks(pass, providerFact('skipped', recent)).priority)
      .toBe('needs_input');
    expect(providerWithChecks(pass, laterPass).priority).toBe('ready');
    expect(providerWithChecks(providerFact('fail', old), laterPass).priority)
      .toBe('failure');
    expect(providerWithChecks(laterPass, providerFact('fail', old)).priority)
      .toBe('failure');
    expect(providerWithChecks(laterPass, providerFact('outcome_unknown', old)).priority)
      .toBe('unknown');
    expect(providerWithChecks(providerFact('unknown', old), laterPass).priority)
      .toBe('unknown');
    expect(providerWithChecks(pass, providerFact('pass', recent, 1)).priority)
      .toBe('needs_input');
    expect(providerWithChecks(providerFact('pass', old, 1), laterPass).priority)
      .toBe('needs_input');
  });

  it('rejects a page cursor after an integration expires without a new checkpoint', () => {
    const older = row('integrations', 'older', 'ready', old);
    const newer = row('integrations', 'newer', 'ready', recent);
    const beforeExpiry = source('integrations', [older, newer]);
    const first = buildOverview([beforeExpiry], 1);
    expect(first.rows.map(item => item.id)).toEqual(['older']);
    expect(first.next).not.toBeNull();

    const expired = { ...newer, priority: 'needs_input' as const };
    const afterExpiry = source('integrations', [older, expired]);
    expect(afterExpiry.checkpoint).toBe(beforeExpiry.checkpoint);
    expect(() => buildOverview([afterExpiry], 1, first.next)).toThrow(
      'Invalid overview cursor');
  });

  it('defaults to 20 rows, caps at 50 and keeps a stable cursor', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row('providers', `provider-${index.toString().padStart(2, '0')}`, 'failure', old));
    const first = buildOverview([source('providers', rows)], undefined, undefined);
    expect(first.rows).toHaveLength(20);
    expect(first.next).toBeTruthy();
    const second = buildOverview([source('providers', rows)], 50, first.next);
    expect(second.rows).toHaveLength(40);
    expect(second.rows[0]?.id).toBe('provider-20');
    const changed = source('providers', rows);
    changed.checkpoint = 13;
    expect(() => buildOverview([changed], 50, first.next)).toThrow();
    expect(() => buildOverview([source('providers', rows)], 51, undefined)).toThrow();
  });

  it('orders priority, event time and source/id ties and deduplicates recorded source ids', () => {
    const rows = [row('providers', 'ready', 'ready', old),
      row('people', 'failure', 'failure', old), row('integrations', 'input', 'needs_input', recent),
      row('spending', 'unknown', 'unknown', recent), row('people', 'old-input', 'needs_input', old),
      row('providers', 'input', 'needs_input', recent)];
    rows[1]!.sourceId = 'same-record';
    rows[2]!.sourceId = 'same-record';
    const overview = buildOverview([source('people', rows)], undefined, undefined);
    expect(overview.rows.map(item => item.id)).toEqual([
      'unknown', 'old-input', 'input', 'input', 'ready']);
  });

  it('keeps other rows and never reports all clear when a source is unavailable', () => {
    const overview = buildOverview([source('people', [row('people', 'one', 'failure', old)]),
      { name: 'spending', status: 'unavailable', checkpoint: null, checkedAt: recent,
        rows: [] }], undefined, undefined);
    expect(overview.rows).toHaveLength(1);
    expect(overview.allClear).toBe(false);
    expect(overview.sources[1]?.status).toBe('unavailable');
  });
});
