import { TestBed } from '@angular/core/testing';
import { AuditScreen } from './audit';

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
  expect(root.textContent).toContain('Decision: allow'); expect(root.textContent).toContain('Observed outcome: Outcome unknown');
  expect(root.textContent).toContain('Observation missing');
  fetch.mockResolvedValueOnce(reply(200, { rows: [] }));
  const filter = root.querySelector<HTMLSelectElement>('select')!; filter.value = 'deny'; filter.dispatchEvent(new Event('change'));
  root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(root.textContent).toContain('No history matches'));
  expect(root.querySelector('[role=status] [data-state]')?.getAttribute('data-state'))
    .toBe('ready');
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
