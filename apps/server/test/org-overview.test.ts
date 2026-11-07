import { describe, expect, it } from 'vitest';
import { buildOverview, type OverviewRow, type OverviewSource } from '../src/overview/rows.ts';

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

describe('organisation overview rows', () => {
  it('defaults to 20 rows, caps at 50 and keeps a stable cursor', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row('providers', `provider-${index.toString().padStart(2, '0')}`, 'failure', old));
    const first = buildOverview([source('providers', rows)], undefined, undefined);
    expect(first.rows).toHaveLength(20);
    expect(first.next).toBeTruthy();
    const second = buildOverview([source('providers', rows)], 50, first.next);
    expect(second.rows).toHaveLength(40);
    expect(second.rows[0]?.id).toBe('provider-20');
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
      'unknown', 'old-input', 'input', 'failure', 'ready']);
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
