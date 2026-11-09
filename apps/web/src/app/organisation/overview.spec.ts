import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OverviewScreen } from './overview';

const checkedAt = '2026-11-08T09:40:00.000Z';
const sources = ['people', 'providers', 'integrations', 'spending', 'memory',
  'publication', 'routines'].map((name) => ({
  name, status: name === 'publication' || name === 'routines' ? 'unavailable' : 'current',
  checkpoint: 1, checkedAt,
}));

function row(id: string, priority: string, source = 'providers', href = '/org/models') {
  return { id, sourceId: id, source, priority, eventAt: checkedAt, revision: 1,
    action: 'view_evidence', href };
}

function reply(rows: unknown[], next: string | null = null, status = 200) {
  const body = { rows, next, allClear: rows.length === 0, sources,
    viewer: { role: 'admin' }, capabilities: {} };
  return new Response(JSON.stringify(body), { status });
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
    expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(4);
  });
  const actions = [...fixture.nativeElement.querySelectorAll('.overview-row a')];
  expect(actions).toHaveLength(4);
  expect(actions.map((action: HTMLAnchorElement) => action.href)).toEqual([
    'http://localhost:3000/org/models', 'http://localhost:3000/org/models',
    'http://localhost:3000/org/models', 'http://localhost:3000/org/models',
  ]);
  expect(fixture.nativeElement.textContent).not.toContain('opaque-1');
});

it('does not call unavailable sources ready or show an undated all-clear', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([]));
  const fixture = await mount();
  await vi.waitFor(() => fixture.detectChanges());
  expect(fixture.nativeElement.textContent).not.toContain('Nothing needs your attention');
  expect(fixture.nativeElement.textContent).toContain('unavailable');
});

it('retains loaded rows after a refresh outage and clears them after access loss', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply([row('private-id', 'unknown')]));
  fetchSpy.mockResolvedValueOnce(reply([], null, 503));
  fetchSpy.mockResolvedValueOnce(reply([], null, 403));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(1);
  });
  const refresh = fixture.nativeElement.querySelector('button');
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Showing what we loaded');
  });
  expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(1);
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(0);
  });
});

it('uses the saved cursor and rejects duplicate rows', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply([row('one', 'unknown')], 'cursor'));
  fetchSpy.mockResolvedValueOnce(reply([row('one', 'unknown'), row('two', 'ready')]));
  const fixture = await mount();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(1);
  });
  fixture.nativeElement.querySelector('.overview-more').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.overview-row')).toHaveLength(2);
  });
  expect(String(fetchSpy.mock.calls[1]?.[0])).toContain('cursor=cursor');
});
