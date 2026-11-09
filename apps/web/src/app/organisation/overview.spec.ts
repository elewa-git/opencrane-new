import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewScreen, overviewDestination } from './overview';

const checkedAt = '2026-11-08T09:40:00.000Z';
const sources = ['people', 'providers', 'integrations', 'spending', 'memory',
  'publication', 'routines'].map((name) => ({
  name, status: name === 'publication' || name === 'routines' ? 'unavailable' : 'current',
  checkpoint: 1, checkedAt,
}));

type Row = Parameters<typeof overviewDestination>[0];

function row(id: string, priority: Row['priority'], source: Row['source'] = 'providers',
  href = '/org/models'): Row {
  return { id, source, priority, eventAt: checkedAt, action: 'view_evidence', href };
}

function reply(rows: unknown[], next: string | null = null, status = 200,
  sourceList = sources) {
  const body = { rows, next, allClear: rows.length === 0, sources: sourceList,
    viewer: { role: 'admin' }, capabilities: {} };
  return new Response(JSON.stringify(body), { status });
}

function root(fixture: ComponentFixture<OverviewScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected overview element');
  return element;
}

async function mount() {
  TestBed.configureTestingModule({ imports: [OverviewScreen] });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(OverviewScreen);
  fixture.detectChanges();
  await vi.waitFor(() => fixture.detectChanges());
  return fixture;
}

beforeEach(() => globalThis.history.replaceState({}, '', '/org/overview'));
afterEach(() => vi.restoreAllMocks());

it('keeps server order and gives each task one safe action', async () => {
  const rows = [row('opaque-1', 'unknown'), row('opaque-2', 'needs_input'),
    row('opaque-3', 'failure'), row('opaque-4', 'ready')];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(rows));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(4);
  });
  const actions = [...root(fixture).querySelectorAll<HTMLAnchorElement>('.overview-row a')];
  expect(actions).toHaveLength(4);
  expect(actions.map((action) => action.href)).toEqual([
    'http://localhost:3000/org/models', 'http://localhost:3000/org/models',
    'http://localhost:3000/org/models', 'http://localhost:3000/org/models',
  ]);
  expect(root(fixture).textContent).not.toContain('opaque-1');
});

it('does not call unavailable sources ready or show an undated all-clear', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([]));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Some tasks are unavailable');
  });
  expect(root(fixture).textContent).not.toContain('Nothing needs your attention');
  expect(root(fixture).textContent).toContain('unavailable');
});

it('retains loaded rows after a refresh outage and clears them after access loss', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply([row('private-id', 'unknown')]));
  fetchSpy.mockResolvedValueOnce(reply([], null, 503));
  fetchSpy.mockResolvedValueOnce(reply([], null, 403));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(1);
  });
  const refresh = root(fixture).querySelector('button');
  if (!refresh) throw new Error('Missing refresh button');
  refresh.focus();
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Showing what we loaded');
  });
  expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(1);
  expect(document.activeElement).toBe(refresh);
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(0);
  });
  expect(root(fixture).querySelector('.overview-row a')).toBeNull();
  refresh.click();
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});

it('uses the saved cursor and rejects duplicate rows', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply([row('one', 'unknown')], 'cursor'));
  fetchSpy.mockResolvedValueOnce(reply([row('one', 'unknown'), row('two', 'ready')]));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(1);
  });
  const more = root(fixture).querySelector<HTMLButtonElement>('.overview-more');
  if (!more) throw new Error('Missing load more button');
  more.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(2);
  });
  expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/org/overview?cursor=cursor');
});

it('shows a dated all-clear only when every source is current', async () => {
  const current = sources.map(source => ({ ...source, status: 'current' }));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([], null, 200, current));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Nothing needs your attention');
  });
  expect(root(fixture).textContent).toContain('8 Nov 2026');
});

it('maps evidence to browser pages and refuses direct API or unsafe links', () => {
  expect(overviewDestination(row('memory', 'unknown', 'memory',
    `/api/org/history/${'a'.repeat(32)}`))).toBe(`/org/history?reference=${'a'.repeat(32)}`);
  expect(overviewDestination(row('permit', 'unknown', 'spending',
    '/api/org/effects/permit-one'))).toBe('/org/spending?effect=permit-one');
  expect(overviewDestination(row('secret', 'unknown', 'memory',
    '/api/org/history/raw-event-id'))).toBeUndefined();
  expect(overviewDestination(row('unsafe', 'unknown', 'integrations',
    '/api/org/integrations/secret'))).toBeUndefined();
});

it('restarts at page one once when a saved cursor has changed', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply([row('one', 'unknown')], 'old'));
  fetchSpy.mockResolvedValueOnce(reply([], null, 400));
  fetchSpy.mockResolvedValueOnce(reply([row('new', 'ready')]));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root(fixture).querySelector('.overview-more')).not.toBeNull();
  });
  const more = root(fixture).querySelector<HTMLButtonElement>('.overview-more');
  more?.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/org/overview?cursor=old');
  expect(fetchSpy.mock.calls[2]?.[0]).toBe('/api/org/overview');
  expect(root(fixture).querySelectorAll('.overview-row')).toHaveLength(1);
});
