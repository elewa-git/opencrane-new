import { TestBed } from '@angular/core/testing';
import { BudgetStopNotice } from './budget-stop-notice';
import type { BudgetStopStatus } from '@opencrane/protocol';

const scopes = ['global', 'paying_group', 'assistant'] as const;
const periods = ['daily', 'monthly'] as const;

function stopped(
  scope: typeof scopes[number],
  period: typeof periods[number],
  remedy: 'ask_admin' | 'ask_admin_or_wait',
  limitCents?: number,
): Extract<BudgetStopStatus, { status: 'stopped' }> {
  return {
    status: 'stopped', stopId: 'stop', calls: [],
    reasons: [{ scope, period, cause: 'bound_refused',
      resetAt: '2026-11-01T00:00:00Z', remedy,
      ...(limitCents === undefined ? {} : { limitCents }) }],
    work: [{ turnId: 'message', execution: 'ended' }],
    positions: { stop: 2, turn: 3, conversation: 4, computer: 5, budget: 6 },
  };
}

function rootOf(fixture: ReturnType<typeof TestBed.createComponent<BudgetStopNotice>>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No budget stop notice');
  return root;
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function mount(reply: unknown, status = 200) {
  const requests: string[] = [];
  const methods: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    requests.push(requestPath(input));
    methods.push(init?.method ?? 'GET');
    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  });
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('turnId', 'message');
  fixture.componentRef.setInput('reconnectedAt', '');
  fixture.componentRef.setInput('endedAt', '');
  fixture.componentRef.setInput('denied', false);
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  return { fixture, requests, methods };
}

afterEach(() => vi.restoreAllMocks());

it.each(scopes)('shows the %s scope with a daily and monthly amount', async scope => {
  for (const period of periods) {
    const { fixture, requests } = await mount(stopped(scope, period, 'ask_admin_or_wait', 20000));
    const label = { global: 'Organisation', paying_group: 'Group', assistant: 'Assistant' }[scope];
    expect(rootOf(fixture).textContent).toContain(`${label} ${period} limit reached: €200.00.`);
    expect(rootOf(fixture).textContent).toContain('Resets 1 Nov 2026, 00:00 UTC. Ask an admin to review the limit.');
    expect(requests).toEqual(['/api/conversations/chat/budget-stops?turnId=message']);
    fixture.destroy();
    vi.restoreAllMocks();
  }
});

it('shows both reasons in reply order and the admin-only remedy', async () => {
  const reply = stopped('assistant', 'daily', 'ask_admin', 20000);
  reply.reasons.push(stopped('global', 'monthly', 'ask_admin_or_wait', 10000).reasons[0]!);
  const { fixture } = await mount(reply);
  const content = rootOf(fixture).textContent ?? '';
  expect(content.indexOf('Assistant daily')).toBeLessThan(content.indexOf('Organisation monthly'));
  expect(content).toContain("Waiting for the reset won't help. Ask an admin to review the limit.");
});

it('keeps the generic notice for a not_stopped reply', async () => {
  const { fixture } = await mount({ status: 'not_stopped' });
  expect(rootOf(fixture).textContent).toContain('Spending limit reached');
  expect(rootOf(fixture).textContent).toContain('next monthly budget period (UTC)');
});

it('does not guess a monthly reset while the stop read is pending', () => {
  const pending = new Promise<Response>(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('turnId', 'message');
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Checking stop details');
  const announcement = rootOf(fixture).querySelector('[role="status"][aria-live="polite"]');
  expect(announcement?.textContent).toContain('Checking saved status');
  expect(rootOf(fixture).textContent).not.toContain('monthly budget period');
});

it('shows no money to another participant and keeps the old stop after reset', async () => {
  const reply = stopped('paying_group', 'monthly', 'ask_admin_or_wait');
  const { fixture } = await mount(reply);
  expect(rootOf(fixture).textContent).not.toContain('€');
  expect(rootOf(fixture).textContent).not.toContain('new monthly limit');
  fixture.componentRef.setInput('now', '2026-11-01T00:00:01Z');
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).not.toContain('new monthly limit');
  fixture.componentRef.setInput('reconnectedAt', '2026-11-01T00:00:01Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('new monthly limit. The stopped work was not repeated.');
  expect(rootOf(fixture).querySelector('button')).toBeNull();
});

it('waits for every reset and does not claim recovery for an admin-only remedy', async () => {
  const reply = stopped('global', 'daily', 'ask_admin_or_wait');
  reply.reasons.push({ ...reply.reasons[0]!, period: 'monthly',
    resetAt: '2026-12-01T00:00:00Z' });
  const { fixture } = await mount(reply);
  fixture.componentRef.setInput('now', '2026-11-02T00:00:00Z');
  fixture.componentRef.setInput('reconnectedAt', '2026-11-02T00:00:00Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).not.toContain('new monthly limit');
  fixture.componentRef.setInput('now', '2026-12-02T00:00:00Z');
  fixture.componentRef.setInput('reconnectedAt', '2026-12-02T00:00:00Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('new monthly limit');
  reply.reasons[1]!.remedy = 'ask_admin';
  const { fixture: adminFixture } = await mount(reply);
  adminFixture.componentRef.setInput('now', '2026-12-02T00:00:00Z');
  adminFixture.componentRef.setInput('reconnectedAt', '2026-12-02T00:00:00Z');
  adminFixture.detectChanges();
  await vi.waitFor(() => expect(adminFixture.componentInstance['loading']()).toBe(false));
  adminFixture.detectChanges();
  expect(rootOf(adminFixture).textContent).not.toContain('new monthly limit');
});

it('shows each matching execution word and leaves out unmatched work', async () => {
  for (const [execution, words] of [
    ['not_started', 'Stopped before it started'],
    ['stopping', 'Stopping'],
    ['ended', 'Stopped'],
  ] as const) {
    const reply = stopped('global', 'monthly', 'ask_admin');
    reply.work[0]!.execution = execution;
    const { fixture } = await mount(reply);
    expect(rootOf(fixture).textContent).toContain(`${words} — spending limit`);
    fixture.destroy();
    vi.restoreAllMocks();
  }
  const reply = stopped('global', 'monthly', 'ask_admin');
  reply.work = [];
  const { fixture } = await mount(reply);
  expect(rootOf(fixture).textContent).not.toContain('— spending limit');
});

it('reads once on first render, reconnection and the end row, without polling', async () => {
  const { fixture, requests, methods } = await mount(stopped('global', 'monthly', 'ask_admin'));
  expect(requests).toHaveLength(1);
  fixture.detectChanges();
  expect(requests).toHaveLength(1);
  fixture.componentRef.setInput('reconnectedAt', '2026-10-16T12:00:00Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.componentRef.setInput('endedAt', '2026-10-16T12:00:01Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  expect(requests).toHaveLength(3);
  expect(methods).toEqual(['GET', 'GET', 'GET']);
});

it.each(['invalid', 'network'])('shows unavailable after a %s reply', async failure => {
  const { fixture } = await mount(stopped('global', 'monthly', 'ask_admin'));
  if (failure === 'network') {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  } else {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'stopped' })));
  }
  fixture.componentRef.setInput('reconnectedAt', '2026-10-16T12:00:00Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expect(rootOf(fixture).textContent).toContain('Organisation');
});

it('ignores an older read and clears details when the conversation changes or access ends', async () => {
  const first = stopped('global', 'monthly', 'ask_admin', 20000);
  const second = stopped('assistant', 'daily', 'ask_admin');
  let finishOld: ((response: Response) => void) | undefined;
  const oldRead = new Promise<Response>(resolve => { finishOld = resolve; });
  const fetchImplementation = vi.fn()
    .mockReturnValueOnce(oldRead)
    .mockResolvedValue(new Response(JSON.stringify(second)));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.componentRef.setInput('conversationId', 'old');
  fixture.componentRef.setInput('turnId', 'message');
  fixture.detectChanges();
  fixture.componentRef.setInput('conversationId', 'new');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  finishOld?.(new Response(JSON.stringify(first)));
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Assistant daily');
  expect(rootOf(fixture).textContent).not.toContain('€');
  fixture.componentRef.setInput('denied', true);
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).not.toContain('Assistant daily');
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
});

it('ignores a stop reply that arrives after access is denied', async () => {
  let finish: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('turnId', 'message');
  fixture.detectChanges();
  fixture.componentRef.setInput('denied', true);
  fixture.detectChanges();
  finish?.(new Response(JSON.stringify(stopped('global', 'monthly', 'ask_admin', 20000))));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Access changed');
  expect(rootOf(fixture).textContent).not.toContain('€');
});

it('keeps the stop visible on unavailable and Check status only reads once', async () => {
  const { fixture, requests, methods } = await mount({}, 503);
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expect(rootOf(fixture).textContent).toContain('This work is still stopped.');
  const button = rootOf(fixture).querySelector('button');
  if (!button) throw new Error('Missing Check status');
  button.click();
  button.click();
  expect(requests).toHaveLength(2);
  expect(methods).toEqual(['GET', 'GET']);
});

it.each([401, 403])('clears protected details after %s', async status => {
  const reply = stopped('global', 'monthly', 'ask_admin', 20000);
  reply.reasons.push(stopped('assistant', 'daily', 'ask_admin', 10000).reasons[0]!);
  const { fixture } = await mount(reply);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
  fixture.componentRef.setInput('reconnectedAt', '2026-10-16T12:00:00Z');
  fixture.detectChanges();
  await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.textContent).toContain('Access changed');
  expect(root.textContent).not.toContain('€');
  expect(root.textContent).not.toContain('Organisation');
  expect(root.textContent).not.toContain('Assistant');
  expect(root.querySelector('button')).toBeNull();
});

it('tells the reader who can help and when the limit resets', () => {
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No budget stop notice');
  expect(root.textContent).toContain('Spending limit reached');
  expect(root.textContent).toContain('An Owner or Admin can review the limit');
  expect(root.textContent).toContain('next monthly budget period (UTC)');
  expect(root.querySelector('[role="alert"]')).toBeNull();
});


function savedCalls(): Extract<BudgetStopStatus, { status: 'stopped' }> {
  const reply = stopped('paying_group', 'monthly', 'ask_admin_or_wait', 20000);
  reply.calls = [
    { reference: 'reserved-call', status: 'held', heldCents: 80 },
    { reference: 'uncertain-' + 'r'.repeat(180), status: 'possibly_sent', heldCents: 40 },
    { reference: 'zero-charge', status: 'charged', chargedCents: 0 },
    { reference: 'released-call', status: 'released' },
    { reference: 'charge-without-amount', status: 'charged' },
  ];
  return reply;
}

function checkStatus(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector('button');
  if (!button || button.textContent?.trim() !== 'Check status') {
    throw new Error('Missing Check status');
  }
  return button;
}

function savedReference(element: Element): string | null {
  return element.textContent;
}

function callReference(call: Extract<BudgetStopStatus, { status: 'stopped' }>['calls'][number]) {
  return call.reference;
}

async function showsSavedCalls() {
  const reply = savedCalls();
  const { fixture } = await mount(reply);
  const root = rootOf(fixture);
  const cards = root.querySelectorAll('.budget-call');
  expect(cards).toHaveLength(5);
  const references = Array.from(root.querySelectorAll('.budget-call code'), savedReference);
  const expectedReferences = reply.calls.map(callReference);
  expect(references).toEqual(expectedReferences);
  expect(cards[0]?.textContent).toContain('Reserved');
  expect(cards[0]?.textContent).toContain('€0.80');
  expect(cards[1]?.textContent).toContain('Outcome unknown');
  expect(cards[1]?.textContent).toContain('may have been sent');
  expect(cards[1]?.textContent).toContain('€0.40');
  expect(cards[2]?.textContent).toContain('Recorded charge');
  expect(cards[2]?.textContent).toContain('€0.00');
  expect(cards[3]?.textContent).toContain('Reservation released');
  expect(cards[3]?.textContent).not.toContain('€');
  expect(cards[4]?.textContent).toContain('Recorded charge');
  expect(cards[4]?.textContent).not.toContain('€');
  expect(root.textContent).not.toMatch(/definitely sent|completed|total/iu);
}

async function showsParticipantCalls() {
  const reply = savedCalls();
  delete reply.reasons[0]!.limitCents;
  for (const call of reply.calls) {
    if ('heldCents' in call) {
      delete call.heldCents;
    }
    if ('chargedCents' in call) {
      delete call.chargedCents;
    }
  }
  const { fixture } = await mount(reply);
  const root = rootOf(fixture);
  expect(root.querySelectorAll('.budget-call')).toHaveLength(5);
  expect(root.textContent).toContain('Outcome unknown');
  expect(root.textContent).toContain('zero-charge');
  expect(root.textContent).not.toMatch(/€|total/iu);
}

async function showsNoInventedCard() {
  const { fixture } = await mount(stopped('global', 'monthly', 'ask_admin'));
  expect(rootOf(fixture).querySelector('.budget-calls')).toBeNull();
  expect(rootOf(fixture).querySelector('button')).toBeNull();
}

async function checksOriginalCall() {
  const { fixture } = await mount(savedCalls());
  let finish: ((response: Response) => void) | undefined;
  function saveResolver(resolve: (response: Response) => void): void {
    finish = resolve;
  }
  const pending = new Promise<Response>(saveResolver);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);
  const button = checkStatus(rootOf(fixture));
  button.click();
  fixture.detectChanges();
  button.click();
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(rootOf(fixture).textContent).toContain('Group monthly limit reached: €200.00.');
  expect(rootOf(fixture).textContent).toContain('Checking saved status');
  const changed = savedCalls();
  changed.calls = [{ reference: 'reserved-call', status: 'charged', chargedCents: 25 }];
  finish?.(new Response(JSON.stringify(changed)));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('€0.25');
  expect(rootOf(fixture).textContent).not.toContain('€0.80');
  expect(rootOf(fixture).querySelectorAll('.budget-call')).toHaveLength(1);
  for (const [, init] of vi.mocked(globalThis.fetch).mock.calls) {
    expect(init?.method ?? 'GET').toBe('GET');
  }
  expect(vi.mocked(globalThis.fetch).mock.calls[1]?.[0])
    .toBe('/api/conversations/chat/budget-stops?turnId=message');
}

async function keepsLastStatus(failure: string) {
  const { fixture } = await mount(savedCalls());
  if (failure === 'network') {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  } else {
    const status = failure === '503' ? 503 : 200;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
  }
  checkStatus(rootOf(fixture)).click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expect(rootOf(fixture).textContent).toContain('Group monthly limit reached: €200.00.');
  expect(rootOf(fixture).textContent).toContain('Outcome unknown');
  expect(rootOf(fixture).querySelectorAll('.budget-call')).toHaveLength(5);
}

async function clearsRefusedCalls(status: number) {
  const { fixture } = await mount(savedCalls());
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
  checkStatus(rootOf(fixture)).click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(rootOf(fixture).textContent).toContain('Access changed');
  const announcement = rootOf(fixture).querySelector('[role="status"][aria-live="polite"]');
  expect(announcement?.textContent).toContain('Access changed');
  expect(rootOf(fixture).querySelector('.budget-calls')).toBeNull();
  expect(rootOf(fixture).querySelector('button')).toBeNull();
}

async function ignoresOldCalls(input: 'turnId' | 'conversationId' | 'denied') {
  const { fixture } = await mount(savedCalls());
  let finish: ((response: Response) => void) | undefined;
  function saveResolver(resolve: (response: Response) => void): void {
    finish = resolve;
  }
  const pending = new Promise<Response>(saveResolver);
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockReturnValueOnce(pending);
  fetch.mockResolvedValue(new Response(JSON.stringify({ status: 'not_stopped' })));
  checkStatus(rootOf(fixture)).click();
  fixture.componentRef.setInput(input, input === 'denied' ? true : 'another');
  fixture.detectChanges();
  finish?.(new Response(JSON.stringify(savedCalls())));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(rootOf(fixture).querySelector('.budget-calls')).toBeNull();
  expect(rootOf(fixture).textContent).not.toContain('reserved-call');
}

it('shows every saved call once, in order, with honest status and optional amounts', showsSavedCalls);
it('shows participant call references and statuses without amounts or totals', showsParticipantCalls);
it('adds no call card or status action for an empty saved list', showsNoInventedCard);
it('checks the original call once while pending and updates without sending work', checksOriginalCall);
it.each(['503', 'network', 'invalid'])('keeps the reason and last call after %s', keepsLastStatus);
it.each([401, 403])('clears saved calls on %s and cannot check them again', clearsRefusedCalls);
const changedInputs = ['turnId', 'conversationId', 'denied'] as const;
it.each(changedInputs)('discards a pending call read after %s changes', ignoresOldCalls);

function pendingStatusRead() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  function rememberCompletion(
    resolveRead: (response: Response) => void,
    rejectRead: (error: Error) => void,
  ): void {
    resolve = resolveRead;
    reject = rejectRead;
  }
  const promise = new Promise<Response>(rememberCompletion);
  function reply(value: unknown, status = 200): void {
    resolve(new Response(JSON.stringify(value), { status }));
  }
  function fail(): void {
    reject(new Error('offline'));
  }
  return { promise, reply, fail };
}

async function renderCompletedRead(
  fixture: ReturnType<typeof TestBed.createComponent<BudgetStopNotice>>,
): Promise<void> {
  function readFinished(): void {
    expect(fixture.componentInstance['loading']()).toBe(false);
  }
  await vi.waitFor(readFinished);
  fixture.detectChanges();
}

async function announcesStatusChecks(): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const root = rootOf(fixture);
  const announcement = root.querySelector('[role="status"][aria-live="polite"]');
  expect(announcement).not.toBeNull();
  expect(announcement?.getAttribute('aria-atomic')).toBe('true');
  const pending = pendingStatusRead();
  vi.mocked(globalThis.fetch).mockReturnValueOnce(pending.promise);
  const button = checkStatus(root);
  button.focus();
  button.click();
  fixture.detectChanges();
  expect(announcement?.textContent).toContain('Checking saved status');
  const changed = savedCalls();
  changed.calls = [{ reference: 'reserved-call', status: 'charged', chargedCents: 25 }];
  pending.reply(changed);
  await renderCompletedRead(fixture);
  expect(announcement?.textContent).toContain('Saved call status checked');
  expect(announcement?.textContent).toContain('Recorded charge');
  expect(document.activeElement).toBe(button);
  vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('offline'));
  button.click();
  await renderCompletedRead(fixture);
  expect(announcement?.textContent).toContain('Stop details unavailable');
  fixture.componentRef.setInput('denied', true);
  fixture.detectChanges();
  expect(announcement?.textContent).toContain('Access changed');
  expect(announcement?.textContent).not.toContain('Recorded charge');
  expect(root.querySelector('[role="status"]')).toBe(announcement);
  expect(root.querySelector('[role="alert"]')).toBeNull();
}

it('politely announces checking, changed calls, failure and access loss', announcesStatusChecks);

function expectNoSavedDetails(root: HTMLElement): void {
  expect(root.querySelector('.budget-calls')).toBeNull();
  expect(root.textContent).not.toContain('reserved-call');
  expect(root.textContent).not.toContain('€');
}

async function clearsSelectionBeforeReply(input: 'conversationId' | 'turnId'): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const oldRead = pendingStatusRead();
  const replacement = pendingStatusRead();
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockReturnValueOnce(oldRead.promise);
  fetch.mockReturnValueOnce(replacement.promise);
  checkStatus(rootOf(fixture)).click();
  fixture.componentRef.setInput(input, 'another');
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
  expect(rootOf(fixture).textContent).toContain('Checking stop details');
  oldRead.reply(savedCalls());
  await settleStatusReply();
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
  replacement.fail();
  await renderCompletedRead(fixture);
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expectNoSavedDetails(rootOf(fixture));
}

async function settleStatusReply(): Promise<void> {
  function afterPendingCallbacks(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  // Let fetch and JSON callbacks finish without waiting for a newer, pending read.
  await new Promise<void>(afterPendingCallbacks);
}

async function hidesUnavailableAfterDenial(): Promise<void> {
  const { fixture } = await mount(savedCalls());
  vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('offline'));
  checkStatus(rootOf(fixture)).click();
  await renderCompletedRead(fixture);
  expect(rootOf(fixture).querySelector('.budget-unavailable')).not.toBeNull();
  fixture.componentRef.setInput('denied', true);
  fixture.detectChanges();
  const root = rootOf(fixture);
  expect(root.textContent).toContain('Access changed');
  expect(root.querySelector('.budget-unavailable')).toBeNull();
  expect(root.querySelector('button')).toBeNull();
  expectNoSavedDetails(root);
}

async function ignoresSameSelectionReply(outcome: 'success' | 'failure' | 'refusal'): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const oldRead = pendingStatusRead();
  const replacement = pendingStatusRead();
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockReturnValueOnce(oldRead.promise);
  fetch.mockReturnValueOnce(replacement.promise);
  const root = rootOf(fixture);
  checkStatus(root).click();
  fixture.componentRef.setInput('reconnectedAt', '2026-10-23T12:00:00Z');
  fixture.detectChanges();
  const changed = savedCalls();
  changed.calls = [{ reference: 'old-reply', status: 'charged', chargedCents: 99 }];
  if (outcome === 'success') {
    oldRead.reply(changed);
  } else if (outcome === 'failure') {
    oldRead.fail();
  } else {
    oldRead.reply({}, 403);
  }
  await settleStatusReply();
  fixture.detectChanges();
  expect(root.textContent).toContain('reserved-call');
  expect(root.textContent).not.toContain('old-reply');
  expect(root.querySelector('.budget-unavailable')).toBeNull();
  expect(root.textContent).not.toContain('Access changed');
  expect(checkStatus(root).getAttribute('aria-disabled')).toBe('true');
  changed.calls = [{ reference: 'latest-reply', status: 'charged', chargedCents: 25 }];
  replacement.reply(changed);
  await renderCompletedRead(fixture);
  expect(root.textContent).toContain('latest-reply');
  expect(root.textContent).toContain('€0.25');
  expect(checkStatus(root).getAttribute('aria-disabled')).toBe('false');
}

async function keepsNewerSameSelectionReply(): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const oldRead = pendingStatusRead();
  const replacement = pendingStatusRead();
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockReturnValueOnce(oldRead.promise);
  fetch.mockReturnValueOnce(replacement.promise);
  checkStatus(rootOf(fixture)).click();
  fixture.componentRef.setInput('endedAt', '2026-10-23T12:00:00Z');
  fixture.detectChanges();
  replacement.reply({ status: 'not_stopped' });
  await renderCompletedRead(fixture);
  expectNoSavedDetails(rootOf(fixture));
  oldRead.reply(savedCalls());
  await settleStatusReply();
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
}

async function ignoresReplyBeforeInputEffect(input: 'conversationId' | 'turnId' | 'denied') {
  const { fixture } = await mount(savedCalls());
  const pending = pendingStatusRead();
  vi.mocked(globalThis.fetch).mockReturnValueOnce(pending.promise);
  checkStatus(rootOf(fixture)).click();
  const original = fixture.componentInstance['details']();
  const changed = savedCalls();
  changed.calls = [{ reference: 'late-reply', status: 'charged', chargedCents: 99 }];
  const changedValue = input === 'denied' ? true : 'another';
  // Change only the input read so the input effect cannot mask a missing response check.
  const inputRead = vi.spyOn(fixture.componentInstance, input);
  inputRead.mockReturnValue(changedValue);
  pending.reply(changed);
  await settleStatusReply();
  expect(fixture.componentInstance['details']()).toBe(original);
  inputRead.mockRestore();
  fixture.componentRef.setInput(input, changedValue);
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
}

async function ignoresReplyAfterDestruction(): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const pending = pendingStatusRead();
  vi.mocked(globalThis.fetch).mockReturnValueOnce(pending.promise);
  checkStatus(rootOf(fixture)).click();
  const original = fixture.componentInstance['details']();
  fixture.destroy();
  const changed = savedCalls();
  changed.calls = [{ reference: 'late-reply', status: 'charged', chargedCents: 99 }];
  pending.reply(changed);
  await settleStatusReply();
  // Check stored state because a destroyed view cannot render a late reply.
  expect(fixture.componentInstance['details']()).toBe(original);
}

async function clearsMissingIdentity(input: 'conversationId' | 'turnId'): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const fetch = vi.mocked(globalThis.fetch);
  fixture.componentRef.setInput(input, '');
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
  expect(fetch).toHaveBeenCalledTimes(1);
}

async function refusesCheckBeforeInputEffect(input: 'conversationId' | 'turnId' | 'denied') {
  const { fixture } = await mount(savedCalls());
  fixture.changeDetectorRef.detach();
  const button = checkStatus(rootOf(fixture));
  fixture.componentRef.setInput(input, input === 'denied' ? true : '');
  button.click();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  fixture.detectChanges();
  expectNoSavedDetails(rootOf(fixture));
}

async function refusesCheckAfterAccessFailure(): Promise<void> {
  const { fixture } = await mount(savedCalls());
  const button = checkStatus(rootOf(fixture));
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 403 }));
  button.click();
  await renderCompletedRead(fixture);
  expect(rootOf(fixture).textContent).toContain('Access changed');
  // Call the action directly because rendering removes its old button after refusal.
  fixture.componentInstance['checkStatus']();
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expectNoSavedDetails(rootOf(fixture));
  expect(rootOf(fixture).querySelector('button')).toBeNull();
}

const selectionInputs = ['conversationId', 'turnId'] as const;
const accessInputs = ['conversationId', 'turnId', 'denied'] as const;
it.each(selectionInputs)('clears old calls immediately while a changed %s read fails',
  clearsSelectionBeforeReply);
it('hides an unavailable status and action when access is denied', hidesUnavailableAfterDenial);
it.each(['success', 'failure', 'refusal'] as const)(
  'ignores an older same-selection %s while the replacement is pending', ignoresSameSelectionReply);
it('keeps a newer same-selection result when an old reply arrives last', keepsNewerSameSelectionReply);
it.each(accessInputs)('ignores a reply before the changed %s input renders',
  ignoresReplyBeforeInputEffect);
it('ignores a reply after the component is destroyed', ignoresReplyAfterDestruction);
it.each(selectionInputs)('clears saved details when %s is missing', clearsMissingIdentity);
it.each(accessInputs)('refuses a check before the changed %s input renders',
  refusesCheckBeforeInputEffect);
it('refuses a saved status action after an access failure', refusesCheckAfterAccessFailure);

const incompatibleCallAmounts = [
  { reference: 'held-with-charge', status: 'held', heldCents: 80, chargedCents: 25 },
  { reference: 'unknown-with-charge', status: 'possibly_sent', heldCents: 40, chargedCents: 25 },
  { reference: 'charge-with-hold', status: 'charged', heldCents: 80 },
  { reference: 'released-with-amounts', status: 'released', heldCents: 80, chargedCents: 25 },
] as const;

async function rejectsIncompatibleCallAmounts(call: typeof incompatibleCallAmounts[number]) {
  const reply = { ...savedCalls(), calls: [call] };
  const { fixture } = await mount(reply);
  expect(rootOf(fixture).textContent).toContain('Stop details unavailable');
  expectNoSavedDetails(rootOf(fixture));
}

function keepsCallStatusAuthoritative(): void {
  const fixture = TestBed.createComponent(BudgetStopNotice);
  const notice = fixture.componentInstance;
  // Check display rules separately from the parser, which also rejects these extra amounts.
  expect(notice['callAmount'](incompatibleCallAmounts[0])).toBe('Reserved: €0.80');
  expect(notice['callAmount'](incompatibleCallAmounts[1])).toBe('Reserved: €0.40');
  expect(notice['callAmount'](incompatibleCallAmounts[2])).toBe('');
  expect(notice['callAmount'](incompatibleCallAmounts[3])).toBe('');
}

it.each(incompatibleCallAmounts)('rejects incompatible money fields for $reference',
  rejectsIncompatibleCallAmounts);
it('uses the call status to decide which supplied amount may be shown', keepsCallStatusAuthoritative);
