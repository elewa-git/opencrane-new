import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { AuditScreen } from './audit';

function screenRoot(fixture: ComponentFixture<AuditScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected screen');
  return element;
}

const row = { id: 'decision', requestId: 'request', permitId: 'permit', conversationId: 'conversation', turnId: 'turn',
  decision: 'allow', outcome: 'unknown', reservedCents: 25,
  records: [{ eventId: 'decision', type: 'decision.recorded', position: 1, source: 'decision', status: 'allow', reason: 'Model call permitted' }] };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());
it('renders loading, unknown outcome, filters, empty, unavailable and access loss without retaining protected details', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.componentRef.setInput('conversationId', 'conversation'); fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  expect(root.textContent).toContain('Action history'); expect(root.textContent).toContain('Loading');
  finish(reply(200, { rows: [row] }));
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  expect(root.textContent).toContain('Decision: allow'); expect(root.textContent).toContain('Observation: Outcome unknown');
  expect(root.textContent).toContain('Observation missing');
  fetch.mockResolvedValueOnce(reply(200, { rows: [] }));
  const filter = root.querySelector<HTMLSelectElement>('select')!; filter.value = 'deny'; filter.dispatchEvent(new Event('change'));
  root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No history matches'));
  expect(root.querySelector('article')).toBeNull();
  expect(root.textContent).not.toContain('Not configured');
  expect(fetch.mock.calls.at(-1)?.[0]).toEqual(expect.stringContaining('decision=deny'));
  fetch.mockResolvedValueOnce(reply(503, { error: 'bearer-private-canary' })); root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('History unavailable'));
  expect(root.textContent).not.toContain('canary'); expect(root.textContent).not.toContain('No history matches');
  fetch.mockResolvedValueOnce(reply(200, { rows: [row] })); root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.querySelector('article')).not.toBeNull());
  fetch.mockResolvedValueOnce(reply(403)); root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Access changed'));
  expect(root.querySelector('article')).toBeNull();
});
it.each(['private fields', 'private reason'])('renders change history with only the strict metadata contract: %s', async variant => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { rows: [variant === 'private fields' ? { ...row, review: 'private-approval-canary', bearer: 'private-bearer-canary' } : { ...row, records: [{ ...row.records[0], reason: 'private-reason-canary' }] }] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  await vi.waitFor(() => expect(root.textContent).toContain('History unavailable'));
  expect(root.textContent).toContain('Change history'); expect(root.textContent).not.toContain('canary');
});

it('shows only supplied child publication facts and a permitted parent link', async () => {
  const publication = { id: 'published-entry', decision: 'not_recorded', outcome: 'recorded',
    records: [{ eventId: 'published-entry', type: 'conversation.child_result_published',
      position: 7, source: 'authoritative', status: 'recorded',
      parentConversationId: 'parent', publicationKind: 'interim',
      taskHref: '/workspace?conversation=parent' }] };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { rows: [publication] }));
  const fixture = TestBed.createComponent(AuditScreen);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  await vi.waitFor(() => expect(root.textContent).toContain('Interim publication'));
  const link = root.querySelector<HTMLAnchorElement>('article a');
  expect(link?.getAttribute('href')).toBe('/workspace?conversation=parent');
  expect(root.textContent).not.toContain('child-result');
  expect(root.textContent).not.toContain('private-report-canary');
});

it('appends cursor pages once, keeps equal-time rows distinct and filters on the server', async () => {
  const first = { ...row, id: 'first', records: [{ ...row.records[0], eventId: 'first',
    recordedAt: '2026-10-04T09:30:00.000Z' }] };
  const second = { ...row, id: 'second', records: [{ ...row.records[0], eventId: 'second',
    recordedAt: '2026-10-04T09:30:00.000Z' }] };
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [first], nextBefore: 8 }))
    .mockResolvedValueOnce(reply(200, { rows: [first, second] }))
    .mockResolvedValueOnce(reply(200, { rows: [second] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelectorAll('article')).toHaveLength(1));
  root.querySelector<HTMLButtonElement>('.older-history')!.click();
  await vi.waitFor(() => expect(root.querySelectorAll('article')).toHaveLength(2));
  expect(fetchSpy.mock.calls[1]?.[0]).toContain('before=8');
  const filter = root.querySelector<HTMLSelectElement>('select[aria-label="Decision filter"]')!;
  filter.value = 'deny'; filter.dispatchEvent(new Event('change'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(root.querySelectorAll('article')).toHaveLength(1));
  expect(fetchSpy.mock.calls[2]?.[0]).toContain('decision=deny');
});

it('opens only the selected detail, pages evidence and returns keyboard focus', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [row] }))
    .mockResolvedValueOnce(reply(200, { id: row.id, records: row.records, nextBefore: 7 }))
    .mockResolvedValueOnce(reply(200, { id: row.id, records: [] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article button')).not.toBeNull());
  const opener = root.querySelector<HTMLButtonElement>('article button')!;
  opener.click();
  await vi.waitFor(() => expect(root.querySelector('.history-detail')).not.toBeNull());
  await vi.waitFor(() => expect(document.activeElement?.classList.contains('close-detail')).toBe(true));
  expect(fetchSpy.mock.calls[1]?.[0]).toContain('/api/org/history/decision');
  root.querySelector<HTMLButtonElement>('.more-evidence')!.click();
  await vi.waitFor(() => expect(fetchSpy.mock.calls[2]?.[0]).toContain('before=7'));
  root.querySelector<HTMLButtonElement>('.close-detail')!.click();
  expect(document.activeElement).toBe(opener);
});

it('keeps dated stale rows on 503, then clears them on denial despite a late detail reply', async () => {
  let finishDetail!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [row] }))
    .mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve; }))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(403));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article button')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('article button')!.click();
  root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('last checked'));
  expect(root.querySelectorAll('article')).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Access changed'));
  finishDetail(reply(200, { id: row.id, records: row.records }));
  await vi.waitFor(() => expect(root.querySelector('.history-detail')).toBeNull());
  expect(root.textContent).not.toContain('Model call permitted');
  expect(fetchSpy).toHaveBeenCalledTimes(4);
});

it('shows restricted publication and memory detail without private text or inferred links', async () => {
  const publication = { eventId: 'published', type: 'conversation.child_result_published',
    position: 4, source: 'authoritative', status: 'recorded',
    parentConversationId: 'parent', publicationKind: 'final',
    taskHref: '/workspace?conversation=parent' };
  const restricted = { eventId: 'restricted', type: 'delegation.completed',
    position: 3, source: 'authoritative', status: 'recorded',
    delegationAccess: 'restricted', joinStatus: 'unavailable' };
  const memory = { eventId: 'memory', type: 'memory.maintenance_recorded',
    position: 2, source: 'authoritative', status: 'recorded',
    maintenanceAction: 'prepared', maintenanceScopeKind: 'person',
    maintenanceScopeId: 'a'.repeat(64), maintenanceMemberId: 'administrator',
    taskHref: `/api/memory/${'a'.repeat(64)}/maintenance` };
  const source = { ...row, id: 'facts', records: [publication, restricted, memory] };
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [source] }))
    .mockResolvedValueOnce(reply(200, { id: 'facts',
      records: [publication, restricted, memory] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article button')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('article button')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Related record'));
  expect(root.querySelectorAll('.history-detail a')).toHaveLength(1);
  expect(root.querySelector<HTMLAnchorElement>('.history-detail a')?.getAttribute('href'))
    .toBe('/workspace?conversation=parent');
  expect(root.textContent).not.toContain('child-private');
  expect(root.textContent).not.toContain('fact-private');
  expect(root.textContent).not.toContain('administrator');
  expect(root.textContent).not.toContain('a'.repeat(64));
  expect(root.textContent).toContain('Unavailable');
});

it('ignores a previous filter reply after the current filter result', async () => {
  let finishOld!: (response: Response) => void;
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [row] }))
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(reply(200, { rows: [] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article')).not.toBeNull());
  const filter = root.querySelector<HTMLSelectElement>('select[aria-label="Decision filter"]')!;
  filter.value = 'allow'; filter.dispatchEvent(new Event('change'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  filter.value = 'deny'; filter.dispatchEvent(new Event('change'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No history matches'));
  finishOld(reply(200, { rows: [row] }));
  await vi.waitFor(() => expect(root.querySelector('article')).toBeNull());
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});

it('checks an unknown record through its selected GET without resending a command', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [row] }))
    .mockResolvedValueOnce(reply(200, { id: row.id, records: row.records }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article button')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('article button + p + button')!.click();
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  expect(fetchSpy.mock.calls[1]?.[0]).toContain('/api/org/history/decision');
  expect(fetchSpy.mock.calls[1]?.[1]).toBeUndefined();
});

it('does not restore a selected detail after the filters change', async () => {
  let finishDetail!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { rows: [row] }))
    .mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve; }))
    .mockResolvedValueOnce(reply(200, { rows: [] }));
  const fixture = TestBed.createComponent(AuditScreen); fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('article button')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('article button')!.click();
  const filter = root.querySelector<HTMLSelectElement>('select[aria-label="Decision filter"]')!;
  filter.value = 'deny'; filter.dispatchEvent(new Event('change'));
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  finishDetail(reply(200, { id: row.id, records: row.records }));
  await vi.waitFor(() => expect(root.textContent).toContain('No history matches'));
  expect(root.querySelector('.history-detail')).toBeNull();
});
