import { describe, expect, it } from 'vitest';
import { buildOverview, type OverviewRow, type OverviewSource } from '../src/overview/rows.ts';
import { providerRow } from '../src/overview/routes.ts';

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
  return providerRow({ state: { providerId: 'provider-one', revision: 2, position: 5,
    reachable, modelAnswer } });
}

describe('organisation overview rows', () => {
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
