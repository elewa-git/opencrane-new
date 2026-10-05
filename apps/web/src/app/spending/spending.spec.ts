import { TestBed } from '@angular/core/testing';
import type { EffectDetail, EffectStatus } from '@opencrane/protocol';
import { z } from 'zod';
import { SpendingScreen } from './spending';

const settleCommandSchema = z.object({
  commandId: z.string().uuid(),
  expectedSequence: z.number().int(),
  outcome: z.literal('settled'),
  settledCents: z.number().int(),
  evidence: z.array(z.object({
    kind: z.literal('provider_receipt'),
    reference: z.string(),
    digest: z.string(),
    amountCents: z.number().int(),
  }).strict()).length(1),
}).strict();

function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

const budget = {
  sequence: 2, defaultPayingGroupId: 'personal-default', periodStart: '2026-10-01T00:00:00.000Z',
  todayCents: 1, monthCents: 1, reservedCents: 25, ceilingCents: 20000,
  dailyCeilingCents: 2000, ceilings: [],
};

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function jsonReply(status: number, body: unknown = {}): Promise<Response> {
  return Promise.resolve(reply(status, body));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('Expected JSON request body');
  return body;
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  return JSON.parse(requestBody(init)) as unknown;
}

function isResolveCall(call: Parameters<typeof fetch>): boolean {
  return requestUrl(call[0]).endsWith('/resolve');
}

function isPermitReadCall(call: Parameters<typeof fetch>): boolean {
  return requestUrl(call[0]) === '/api/org/effects/permit-1';
}

function fixtureRoot(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Missing spending screen root');
  return value;
}

function effect(overrides: Partial<EffectStatus> = {}): EffectStatus {
  return {
    permitId: 'permit-1', reservationId: 'permit-1', reservedAt: '2026-10-05T08:00:00.000Z',
    reservedCents: 120, settledCents: null, model: 'model-a', priceTableId: 'prices-1',
    sequence: 3, state: 'outcome_unknown', label: 'Outcome unknown', conflict: false,
    reasons: ['settle_timeout'], observations: [], resolution: null,
    ...overrides,
  };
}

function detail(overrides: Partial<EffectDetail> = {}): EffectDetail {
  return { ...effect(), csrf: 'c'.repeat(64), ...overrides };
}

function defaultFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return function readDefaults(input: RequestInfo | URL): Promise<Response> {
    const url = requestUrl(input);
    if (url === '/api/org/models') return jsonReply(200, { budget });
    if (url === '/api/org/effects') return jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) return jsonReply(202, { status: 'appended' });
    return jsonReply(200, detail());
  };
}

async function mountScreen(): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(SpendingScreen);
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => expect(root.textContent).toContain('permit-1'));
  return root;
}

function submitButton(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('oc-effect-resolution-drawer form button[type="submit"]');
  if (!button) throw new Error('Missing resolution button');
  return button;
}

function buttonText(button: HTMLButtonElement): string {
  return button.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
}

function inputValue(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing input ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function openReview(root: HTMLElement): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>('oc-held-effects-list button');
  if (!button) throw new Error('Missing Check status button');
  button.click();
  return button;
}

async function waitForForm(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(root.querySelector('#receipt-reference')).not.toBeNull());
}

async function fillSettleForm(root: HTMLElement): Promise<void> {
  inputValue(root, '#settle-cents', '120');
  inputValue(root, '#receipt-reference', 'provider-receipt-1');
  inputValue(root, '#receipt-digest', 'a'.repeat(64));
  await vi.waitFor(() => expect(buttonText(submitButton(root))).toBe('Settle €1.20 (120 cents)'));
}

beforeEach(() => {
  Object.assign(HTMLDialogElement.prototype, { showModal, close: closeDialog });
});

afterEach(() => vi.restoreAllMocks());

it('keeps running calls in the waiting count without a Check status button', async () => {
  const running = effect({ permitId: 'permit-running', reasons: [], conflict: false });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function listHeldAndRunning(input) {
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [effect(), running] });
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  expect(root.textContent).toContain('1 calls still waiting for final usage');
  expect(root.querySelectorAll('oc-held-effects-list button')).toHaveLength(1);
  expect(root.textContent).not.toContain('permit-running');
});

it('checks by GET and sends one exact settle POST with the latest CSRF token', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultFetch());
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  const submit = submitButton(root);
  expect(buttonText(submit)).toBe('Settle €1.20 (120 cents)');
  submit.click();
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(isResolveCall)).toBe(true));
  const detailRead = fetchMock.mock.calls.find(isPermitReadCall);
  expect(detailRead?.[1]?.method).toBeUndefined();
  const post = fetchMock.mock.calls.find(isResolveCall);
  expect(post?.[1]?.method).toBe('POST');
  expect(post?.[1]?.headers).toEqual({ 'content-type': 'application/json', 'X-CSRF-Token': 'c'.repeat(64) });
  const sentCommand = settleCommandSchema.parse(parseRequestBody(post?.[1]));
  expect(sentCommand).toEqual({
    commandId: sentCommand.commandId, expectedSequence: 3, outcome: 'settled', settledCents: 120,
    evidence: [{ kind: 'provider_receipt', reference: 'provider-receipt-1', digest: 'a'.repeat(64), amountCents: 120 }],
  });
});

it('does not send a second POST while the first resolution is pending', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function holdPost(input) {
    if (requestUrl(input).endsWith('/resolve')) {
      return await new Promise<Response>(resolve => { finishPost = resolve; });
    }
    return await defaultFetch()(input);
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  const submit = submitButton(root);
  submit.click();
  submit.click();
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
  finishPost?.(reply(503, { status: 'unavailable' }));
  await vi.waitFor(() => expect(root.textContent).toContain('Not recorded. Nothing changed.'));
});

it('reads a 202 through pending to settled without sending another POST', async () => {
  let detailReads = 0;
  const settled = detail({ state: 'settled', label: 'Settled', settledCents: 120 });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function readResolution(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) return await jsonReply(202, { status: 'appended' });
    detailReads += 1;
    if (detailReads === 1) return await jsonReply(200, detail());
    if (detailReads === 2) return await jsonReply(200, detail({ state: 'resolution_pending', label: 'Resolution pending',
      resolution: { outcome: 'settled', settledCents: 120, evidence: [] } }));
    return await jsonReply(200, settled);
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  const submit = submitButton(root);
  submit.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Recorded. Waiting for the budget to apply it.'));
  const check = Array.from(root.querySelectorAll<HTMLButtonElement>('oc-effect-resolution-drawer button')).find(button =>
    button.textContent?.includes('Check status'));
  if (!check) throw new Error('Missing drawer Check status button');
  check.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Settled €1.20 for permit-1'));
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
});

it('uses GET only after a lost reply and recognises a matching recorded resolution', async () => {
  let postSent = false;
  const matching = detail({ conflict: true, resolution: {
    outcome: 'settled', settledCents: 120,
    evidence: [{ kind: 'provider_receipt', reference: 'provider-receipt-1', digest: 'a'.repeat(64), amountCents: 120 }],
  } });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function lostReply(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) {
      postSent = true;
      return await jsonReply(503, { status: 'unavailable' });
    }
    if (postSent) return await jsonReply(200, matching);
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  const submit = submitButton(root);
  submit.click();
  await vi.waitFor(() => expect(root.textContent).toContain('A resolution matching yours is recorded.'));
  const calls = fetchMock.mock.calls;
  expect(calls.filter(isResolveCall)).toHaveLength(1);
  expect(calls.filter(isPermitReadCall).length).toBeGreaterThanOrEqual(2);
});

it('shows an already resolved result without naming an admin', async () => {
  let postSent = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function conflictReply(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) {
      postSent = true;
      return await jsonReply(409, { status: 'conflict' });
    }
    if (!postSent) return await jsonReply(200, detail());
    return await jsonReply(200, detail({ conflict: true, resolution: {
      outcome: 'settled', settledCents: 180, evidence: [],
    } }));
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  root.querySelector<HTMLFormElement>('oc-effect-resolution-drawer form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('This hold was already resolved: Settled €1.80'));
  expect(root.textContent).not.toContain('admin');
});

it('shows insufficient evidence after a held response', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function heldReply(input) {
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (requestUrl(input).endsWith('/resolve')) return await jsonReply(409, { status: 'held' });
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  await vi.waitFor(() => expect(root.textContent).toContain("Can't confirm with this evidence. The hold stays."));
  expect(root.querySelector('oc-effect-resolution-drawer form')).toBeNull();
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
});

it('disables release for charged usage', async () => {
  const charged = effect({ observations: [{ eventId: 'event-1', outcome: 'error', costCents: 1 }] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function readCharged(input) {
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [charged] });
    return await jsonReply(200, detail(charged));
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  expect(root.querySelector<HTMLInputElement>('input[value="released"]')?.disabled).toBe(true);
  expect(root.textContent).toContain("Usage with a cost was recorded, so the hold can't be released.");
});

it('sends a release with zero cents and the checked non-dispatch record', async () => {
  const free = effect({ observations: [{ eventId: 'event-1', outcome: 'error', costCents: 0 }] });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function releaseRoute(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [free] });
    if (url.endsWith('/resolve')) return await jsonReply(202, { status: 'appended' });
    return await jsonReply(200, detail(free));
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  const releaseOption = root.querySelector<HTMLInputElement>('input[value="released"]');
  if (!releaseOption) throw new Error('Missing Release choice');
  releaseOption.checked = true;
  releaseOption.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector('input[type="checkbox"]')).not.toBeNull());
  inputValue(root, '#receipt-reference', 'dispatch-check-1');
  inputValue(root, '#receipt-digest', 'b'.repeat(64));
  const notDispatched = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!notDispatched) throw new Error('Missing non-dispatch checkbox');
  notDispatched.checked = true;
  notDispatched.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(submitButton(root).disabled).toBe(false));
  submitButton(root).click();
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(isResolveCall)).toBe(true));
  const post = fetchMock.mock.calls.find(isResolveCall);
  expect(parseRequestBody(post?.[1])).toMatchObject({ settledCents: 0, outcome: 'released',
    evidence: [{ kind: 'dispatch_record', notDispatched: true }] });
});

it('clears all protected values and closes the drawer after a POST refusal', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function refusePost(input) {
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (requestUrl(input).endsWith('/resolve')) return await jsonReply(403, { status: 'refused' });
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  await vi.waitFor(() => expect(root.textContent).toContain('Spending needs the Owner or Admin role.'));
  expect(root.textContent).not.toContain('permit-1');
  expect(root.textContent).not.toContain('personal-default');
  expect(root.querySelector('oc-effect-resolution-drawer')).toBeNull();
});

it('ignores a detail reply that arrives after access was refused by the list read', async () => {
  let finishDetail: ((response: Response) => void) | undefined;
  let denyList = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function lateDetail(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects' && denyList) return await jsonReply(403, { status: 'refused' });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url === '/api/org/effects/permit-1') {
      return await new Promise<Response>(resolve => { finishDetail = resolve; });
    }
    return await jsonReply(200, detail());
  });
  const fixture = TestBed.createComponent(SpendingScreen);
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => expect(root.textContent).toContain('permit-1'));
  openReview(root);
  denyList = true;
  root.querySelector<HTMLButtonElement>('.refresh-actions button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Spending needs the Owner or Admin role.'));
  finishDetail?.(reply(200, detail()));
  await Promise.resolve();
  expect(root.textContent).not.toContain('permit-1');
});

it('keeps loaded data after a read failure and shows separate unavailable states for 503 replies', async () => {
  let failReads = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function failRefresh(input) {
    const url = requestUrl(input);
    if (failReads && url === '/api/org/models') return await jsonReply(500);
    if (failReads && url === '/api/org/effects') return await jsonReply(500);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    return await jsonReply(200, detail());
  });
  const fixture = TestBed.createComponent(SpendingScreen);
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => expect(root.textContent).toContain('permit-1'));
  failReads = true;
  root.querySelector<HTMLButtonElement>('.refresh-actions button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Showing what we loaded at'));
  expect(root.textContent).toContain('permit-1');
  fetchMock.mockImplementation(async function unavailableReads(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models' || url === '/api/org/effects') return await jsonReply(503);
    return await jsonReply(200, detail());
  });
  root.querySelector<HTMLButtonElement>('.refresh-actions button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Budget service unavailable'));
  expect(root.textContent).toContain('Spend evidence unavailable');
  expect(root.textContent).toContain('permit-1');
});
