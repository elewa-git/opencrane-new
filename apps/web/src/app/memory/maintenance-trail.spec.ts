import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MaintenanceTrail } from './maintenance-trail';

const runA = 'a'.repeat(64);
const runB = 'b'.repeat(64);
const time = '2026-10-04T02:00:00.000Z';
const rowA = { runId: runA, action: 'prepared', intendedAt: time, selectedAt: time,
  observedAt: time, money: { status: 'unavailable' } };
const rowB = { ...rowA, runId: runB, action: 'missed' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function page(history: unknown[], nextCursor: string | null) {
  return { status: 'qualification_blocked', binding: { enabled: true,
    memberId: 'owner', assistantId: 'assistant', payingGroupId: 'payer',
    acceptedCapCents: 100 }, nextAt: time, history, nextCursor };
}

function detail(row: typeof rowA) {
  return { ...row, memberId: 'owner', allowanceCents: 100,
    startedAt: null, rootId: row.action === 'prepared' ? 'saved-root' : null };
}

async function mount(): Promise<ComponentFixture<MaintenanceTrail>> {
  TestBed.configureTestingModule({ imports: [MaintenanceTrail] });
  const fixture = TestBed.createComponent(MaintenanceTrail);
  fixture.componentRef.setInput('scopeId', 'private-scope');
  fixture.componentRef.setInput('audience', 'Only you');
  fixture.componentRef.setInput('requesterId', 'owner');
  fixture.detectChanges();
  await vi.waitFor(function loaded() {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Nightly maintenance');
  });
  return fixture;
}

function button(fixture: ComponentFixture<MaintenanceTrail>, name: string): HTMLButtonElement {
  const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
  const found = Array.from(buttons).find(function matches(item) {
    return item.textContent?.includes(name);
  });
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

afterEach(function reset() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

it('appends one page in saved order and shows empty only after the final page', async () => {
  const calls: string[] = [];
  function read(input: RequestInfo | URL): Promise<Response> {
    const url = String(input);
    calls.push(url);
    if (url.includes('?cursor=next')) return Promise.resolve(reply(page([rowB], null)));
    return Promise.resolve(reply(page([rowA], 'next')));
  }
  vi.stubGlobal('fetch', vi.fn(read));
  const fixture = await mount();
  expect(fixture.nativeElement.textContent).not.toContain('No maintenance yet');
  button(fixture, 'Load more').click();
  await vi.waitFor(function appended() {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.maintenance-row')).toHaveLength(2);
  });
  expect(calls).toEqual(['/api/memory/private-scope/maintenance',
    '/api/memory/private-scope/maintenance?cursor=next']);
  expect(fixture.nativeElement.textContent).not.toContain('No maintenance yet');
});

it('keeps the clicked original detail when an older reply arrives late', async () => {
  let releaseOlder: ((value: Response) => void) | undefined;
  function read(input: RequestInfo | URL): Promise<Response> {
    const url = String(input);
    if (url.endsWith(runA)) {
      return new Promise<Response>(function pending(resolve) { releaseOlder = resolve; });
    }
    if (url.endsWith(runB)) return Promise.resolve(reply(detail(rowB)));
    return Promise.resolve(reply(page([rowA, rowB], null)));
  }
  vi.stubGlobal('fetch', vi.fn(read));
  const fixture = await mount();
  const rows = fixture.nativeElement.querySelectorAll('.maintenance-row') as
    NodeListOf<HTMLButtonElement>;
  rows[0]!.click();
  rows[1]!.click();
  await vi.waitFor(function newer() {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Missed');
  });
  releaseOlder?.(reply(detail(rowA)));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Missed');
  expect(fixture.nativeElement.textContent).not.toContain('Saved for preparation');
});

it('keeps safe rows after 503, then clears them on denied access', async () => {
  let reads = 0;
  function read(): Promise<Response> {
    reads += 1;
    if (reads === 2) return Promise.resolve(reply({}, 503));
    if (reads === 3) return Promise.resolve(reply({}, 403));
    return Promise.resolve(reply(page([rowA], null)));
  }
  vi.stubGlobal('fetch', vi.fn(read));
  const fixture = await mount();
  button(fixture, 'Refresh').click();
  await vi.waitFor(function unavailable() {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Try again');
  });
  expect(fixture.nativeElement.querySelectorAll('.maintenance-row')).toHaveLength(1);
  button(fixture, 'Try again').click();
  await vi.waitFor(function denied() {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Access changed');
  });
  expect(fixture.nativeElement.querySelectorAll('.maintenance-row')).toHaveLength(0);
});

it('shows saved owner, times and allowance without claiming spend or sources', async () => {
  const calls: string[] = [];
  function read(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).endsWith(runA)) return Promise.resolve(reply(detail(rowA)));
    return Promise.resolve(reply(page([rowA], null)));
  }
  vi.stubGlobal('fetch', vi.fn(read));
  const fixture = await mount();
  button(fixture, 'Saved for preparation').click();
  await vi.waitFor(function opened() {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Accepted allowance');
  });
  const text = fixture.nativeElement.textContent as string;
  expect(text).toContain('owner');
  expect(text).toContain('Actual start unavailable');
  expect(text).toContain('Hold and settlement unavailable');
  expect(text).toContain('Source links unavailable');
  button(fixture, 'Check status').click();
  await fixture.whenStable();
  button(fixture, 'Back').click();
  expect(calls.every(function getOnly(call) { return call.startsWith('GET '); })).toBe(true);
  expect(calls.filter(function original(call) { return call.endsWith(runA); })).toHaveLength(2);
});
