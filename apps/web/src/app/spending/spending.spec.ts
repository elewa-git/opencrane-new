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
  const button = root.querySelector<HTMLButtonElement>(
    'oc-effect-resolution-drawer [form="resolution-form"]',
  );
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

it('sends integer cents, prevents duplicate saves, requires a fresh read after uncertainty and clears budget data on access loss', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function initialBudgetReads(input) {
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [] });
    return await jsonReply(200, {});
  });
  const fixture = TestBed.createComponent(SpendingScreen);
  fixture.detectChanges();
  const root = fixtureRoot(fixture.nativeElement);
  await vi.waitFor(() => expect(root.querySelector('#monthly-ceiling')).not.toBeNull());
  const ceiling = root.querySelector<HTMLInputElement>('#monthly-ceiling');
  if (!ceiling) throw new Error('Missing monthly ceiling field');
  ceiling.value = '12345';
  ceiling.dispatchEvent(new Event('input'));
  fixture.detectChanges();

  let finishSave: ((response: Response) => void) | undefined;
  fetchMock.mockImplementation(async function holdBudgetSave(input, init) {
    if (requestUrl(input) === '/api/org/models' && init?.method === 'POST') {
      return await new Promise<Response>(resolve => { finishSave = resolve; });
    }
    return await jsonReply(200, { budget });
  });
  root.querySelector<HTMLFormElement>('.budget-form')?.dispatchEvent(
    new SubmitEvent('submit', { bubbles: true, cancelable: true }),
  );
  fixture.detectChanges();
  const fieldset = root.querySelector<HTMLFieldSetElement>('.budget-form fieldset');
  expect(fieldset?.disabled).toBe(true);
  const saveCall = fetchMock.mock.calls.find(call => call[1]?.method === 'POST');
  expect(parseRequestBody(saveCall?.[1])).toMatchObject({
    scope: 'global', ceilingCents: 12345, expectedSequence: 2,
  });
  finishSave?.(reply(503));
  await vi.waitFor(() => expect(root.textContent).toContain('Could not confirm the change'));
  expect(root.textContent).toContain('Change reference:');
  expect(root.querySelector<HTMLFieldSetElement>('.budget-form fieldset')?.disabled).toBe(true);

  root.querySelector<HTMLButtonElement>('.refresh')?.click();
  await vi.waitFor(() => expect(
    root.querySelector<HTMLFieldSetElement>('.budget-form fieldset')?.disabled,
  ).toBe(false));

  fetchMock.mockResolvedValueOnce(reply(403));
  root.querySelector<HTMLButtonElement>('.refresh')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Spending needs the Owner or Admin role.'));
  expect(root.querySelector('.budget-form')).toBeNull();
  expect(root.textContent).not.toContain('personal-default');
});

it('keeps typed budget values when validation fails', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultFetch());
  const root = await mountScreen();
  inputValue(root, '#monthly-ceiling', '45000');
  inputValue(root, '#default-group', 'bad group!');
  root.querySelector<HTMLFormElement>('.budget-form')?.requestSubmit();

  await vi.waitFor(() => expect(root.textContent).toContain('Enter a valid id'));
  expect(root.querySelector<HTMLInputElement>('#monthly-ceiling')?.value).toBe('45000');
  expect(root.querySelector<HTMLInputElement>('#default-group')?.value).toBe('bad group!');
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
});

it('keeps the typed ceiling after an uncertain budget save and checks status with one GET', async () => {
  const rejectSave = true;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function budgetStatus(input, init) {
    const url = requestUrl(input);
    if (url === '/api/org/models' && init?.method === 'POST' && rejectSave) {
      return await jsonReply(503);
    }
    return await defaultFetch()(input);
  });
  const root = await mountScreen();
  inputValue(root, '#monthly-ceiling', '30000');
  root.querySelector<HTMLFormElement>('.budget-form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('Could not confirm the change'));
  expect(root.querySelector<HTMLInputElement>('#monthly-ceiling')?.value).toBe('30000');
  expect(root.textContent).toContain('Change reference:');

  const checksBefore = fetchMock.mock.calls.filter(call =>
    requestUrl(call[0]) === '/api/org/models' && call[1]?.method !== 'POST',
  ).length;
  root.querySelector<HTMLButtonElement>('.budget-form oc-shared-state button')?.click();
  await vi.waitFor(() => expect(fetchMock.mock.calls.filter(call =>
    requestUrl(call[0]) === '/api/org/models' && call[1]?.method !== 'POST',
  )).toHaveLength(checksBefore + 1));
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
});

it('uses a new command id for each budget save in one visit', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultFetch());
  const root = await mountScreen();
  const form = root.querySelector<HTMLFormElement>('.budget-form');
  form?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('Budget saved'));
  form?.requestSubmit();
  await vi.waitFor(() => expect(fetchMock.mock.calls.filter(call =>
    call[1]?.method === 'POST',
  )).toHaveLength(2));
  const ids: string[] = [];
  for (const call of fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')) {
    const command = z.object({ commandId: z.string() }).parse(parseRequestBody(call[1]));
    ids.push(command.commandId);
  }
  expect(new Set(ids).size).toBe(2);
  expect(ids.every(id => /^[0-9a-f-]{36}$/u.test(id))).toBe(true);
});

it('keeps running calls in the waiting count without a Check status button', async () => {
  const running = effect({ permitId: 'permit-running', reasons: [], conflict: false });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async function listHeldAndRunning(input) {
    if (requestUrl(input) === '/api/org/effects') return await jsonReply(200, { effects: [effect(), running] });
    if (requestUrl(input) === '/api/org/models') return await jsonReply(200, { budget });
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  expect(root.textContent).toContain('1 call still waiting for final usage');
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

it('sends no resolve POST for an invalid submit or Enter in a field', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultFetch());
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  inputValue(root, '#settle-cents', '1.2');

  const form = root.querySelector<HTMLFormElement>('#resolution-form');
  const amount = root.querySelector<HTMLInputElement>('#settle-cents');
  if (!form || !amount) throw new Error('Missing resolution form');
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  amount.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(0);
});

it('opens the second hold with a form after settling the first hold', async () => {
  let firstHoldSettled = false;
  const second = effect({ permitId: 'permit-2', reservationId: 'permit-2', sequence: 7 });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function readTwoHolds(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') {
      const effects = firstHoldSettled ? [second] : [effect(), second];
      return await jsonReply(200, { effects });
    }
    if (url.endsWith('/resolve')) {
      firstHoldSettled = true;
      return await jsonReply(202, { status: 'appended' });
    }
    if (url === '/api/org/effects/permit-1') {
      return await jsonReply(200, detail(firstHoldSettled ? {
        state: 'settled', label: 'Settled', settledCents: 120,
        resolution: {
          outcome: 'settled', settledCents: 120,
          evidence: [{ kind: 'provider_receipt', reference: 'provider-receipt-1',
            digest: 'a'.repeat(64), amountCents: 120 }],
        },
      } : {}));
    }
    if (url === '/api/org/effects/permit-2') return await jsonReply(200, detail(second));
    return await jsonReply(404);
  });

  const root = await mountScreen();
  const firstButton = root.querySelector<HTMLButtonElement>('oc-held-effects-list button');
  firstButton?.click();
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  await vi.waitFor(() => expect(root.textContent).toContain('Settled €1.20 for permit-1'));
  const backButton = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'oc-effect-resolution-drawer button',
  )).find(button => button.textContent?.includes('Back'));
  backButton?.click();

  const secondButton = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'oc-held-effects-list button',
  )).find(button => button.getAttribute('aria-describedby') === 'permit-permit-2');
  secondButton?.click();
  await vi.waitFor(() => expect(root.querySelector('#receipt-reference')).not.toBeNull());
  expect(root.textContent).not.toContain('evidence changed while you were reviewing');
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
});

it('keeps the second hold steady while the first hold has a pending command', async () => {
  let finishFirstPost: ((response: Response) => void) | undefined;
  const second = effect({ permitId: 'permit-2', reservationId: 'permit-2', sequence: 7 });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function holdFirstCommand(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect(), second] });
    if (url.endsWith('/resolve')) {
      return await new Promise<Response>(resolve => { finishFirstPost = resolve; });
    }
    if (url === '/api/org/effects/permit-2') return await jsonReply(200, detail(second));
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  root.querySelector<HTMLButtonElement>('dialog[open] > header .back')?.click();
  const secondButton = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'oc-held-effects-list button',
  )).find(button => button.getAttribute('aria-describedby') === 'permit-permit-2');
  secondButton?.click();
  await vi.waitFor(() => expect(root.querySelector('#receipt-reference')).not.toBeNull());

  const firstPermitReads = fetchMock.mock.calls.filter(call =>
    requestUrl(call[0]) === '/api/org/effects/permit-1').length;
  finishFirstPost?.(reply(503));
  await vi.waitFor(() => expect(root.textContent).toContain('We couldn\'t tell whether'));

  expect(root.querySelector('#receipt-reference')).not.toBeNull();
  expect(fetchMock.mock.calls.filter(call =>
    requestUrl(call[0]) === '/api/org/effects/permit-1')).toHaveLength(firstPermitReads);
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

it('reopens an in-flight hold without saying it was not recorded or enabling another save', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  let settled = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function heldResolution(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) {
      return await new Promise<Response>(resolve => { finishPost = resolve; });
    }
    if (settled) {
      return await jsonReply(200, detail({
        state: 'settled', label: 'Settled', settledCents: 120, sequence: 4,
        resolution: {
          outcome: 'settled', settledCents: 120,
          evidence: [{ kind: 'provider_receipt', reference: 'provider-receipt-1',
            digest: 'a'.repeat(64), amountCents: 120 }],
        },
      }));
    }
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();

  const dialog = root.querySelector<HTMLDialogElement>('dialog[open]');
  dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
  openReview(root);
  await vi.waitFor(() => expect(root.textContent).toContain('A resolution for this hold'));
  expect(root.textContent).toContain('Its reference is');
  expect(root.textContent).not.toContain('Not recorded. Nothing changed.');
  expect(submitButton(root).getAttribute('aria-disabled')).toBe('true');

  submitButton(root).click();
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
  settled = true;
  finishPost?.(reply(202, { status: 'appended' }));
  await vi.waitFor(() => expect(root.textContent).toContain('Settled €1.20 for permit-1'));
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
});

it('shows a refusal on the page when the resolution drawer closed before the reply', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function refusedClosedPost(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) {
      return await new Promise<Response>(resolve => { finishPost = resolve; });
    }
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  root.querySelector<HTMLDialogElement>('dialog[open]')?.dispatchEvent(
    new Event('cancel', { cancelable: true }),
  );
  finishPost?.(reply(400, { status: 'invalid' }));

  await vi.waitFor(() => expect(root.textContent).toContain(
    'The server refused this entry. Nothing was recorded.',
  ));
  expect(root.querySelector('oc-effect-resolution-drawer')).toBeNull();
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(1);
});

it('checks a closed pending resolution with one GET after a lost reply', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  let failNextDetailRead = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async function loseReply(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models') return await jsonReply(200, { budget });
    if (url === '/api/org/effects') return await jsonReply(200, { effects: [effect()] });
    if (url.endsWith('/resolve')) {
      return await new Promise<Response>(resolve => { finishPost = resolve; });
    }
    if (url === '/api/org/effects/permit-1' && failNextDetailRead) {
      failNextDetailRead = false;
      return await jsonReply(500);
    }
    return await jsonReply(200, detail());
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  submitButton(root).click();
  const back = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'oc-effect-resolution-drawer button',
  )).find(button => button.textContent?.includes('Back'));
  back?.click();
  failNextDetailRead = true;
  finishPost?.(reply(503));
  await vi.waitFor(() => expect(root.textContent).toContain('We couldn\'t tell whether'));
  const postCountBeforeCheck = fetchMock.mock.calls.filter(isResolveCall).length;
  const detailCountBeforeCheck = fetchMock.mock.calls.filter(isPermitReadCall).length;
  const checkButton = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(button =>
    button.textContent?.includes('Check status'));
  checkButton?.click();
  await vi.waitFor(() => expect(fetchMock.mock.calls.filter(isPermitReadCall).length)
    .toBe(detailCountBeforeCheck + 1));
  expect(fetchMock.mock.calls.filter(isResolveCall)).toHaveLength(postCountBeforeCheck);
});

it('does not report a failure when refreshing a healthy spending page', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(defaultFetch());
  const root = await mountScreen();
  root.querySelector<HTMLButtonElement>('.refresh-actions .refresh')?.click();
  await vi.waitFor(() => expect(fetchMock.mock.calls.filter(call =>
    requestUrl(call[0]) === '/api/org/effects').length).toBe(2));
  expect(root.textContent).not.toContain('Could not load');
  expect(root.textContent).not.toContain('unavailable');
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
    if (detailReads === 2) return await jsonReply(200, detail({
      state: 'resolution_pending', label: 'Resolution pending',
      resolution: {
        outcome: 'settled', settledCents: 120,
        evidence: [{ kind: 'provider_receipt', reference: 'provider-receipt-1',
          digest: 'a'.repeat(64), amountCents: 120 }],
      },
    }));
    return await jsonReply(200, settled);
  });
  const root = await mountScreen();
  openReview(root);
  await waitForForm(root);
  await fillSettleForm(root);
  const submit = submitButton(root);
  submit.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Waiting for the budget to apply it.'));
  const check = Array.from(root.querySelectorAll<HTMLButtonElement>('oc-effect-resolution-drawer button')).find(button =>
    button.textContent?.includes('Check again'));
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
  await vi.waitFor(() => expect(root.textContent).toContain('Showing the last spending details'));
  expect(root.textContent).toContain('permit-1');
  fetchMock.mockImplementation(async function unavailableReads(input) {
    const url = requestUrl(input);
    if (url === '/api/org/models' || url === '/api/org/effects') return await jsonReply(503);
    return await jsonReply(200, detail());
  });
  root.querySelector<HTMLButtonElement>('.refresh-actions button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Showing the last spending details'));
  expect(root.querySelectorAll('.stale')).toHaveLength(1);
  expect(root.textContent).toContain('permit-1');
});


async function correctsUnavailableChoice() {
  function refuseChoice(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (requestUrl(input) === '/api/org/models' && init?.method === 'POST') {
      return jsonReply(422, { status: 'refused', reason: 'spending_choice_unavailable' });
    }
    return defaultFetch()(input);
  }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(refuseChoice);
  const root = await mountScreen();
  inputValue(root, '#monthly-ceiling', '45000');
  inputValue(root, '#default-group', 'unknown-payer');
  root.querySelector<HTMLFormElement>('.budget-form')?.requestSubmit();
  function expectCorrectableRefusal() {
    const editor = root.querySelector('.budget-form');
    expect(editor?.textContent).toContain(
      'This spending choice is unavailable. Choose another group or active shared assistant.',
    );
  }
  await vi.waitFor(expectCorrectableRefusal);
  expect(root.querySelector<HTMLInputElement>('#monthly-ceiling')?.value).toBe('45000');
  expect(root.querySelector<HTMLInputElement>('#default-group')?.value).toBe('unknown-payer');
  expect(root.querySelector<HTMLFieldSetElement>('.budget-form fieldset')?.disabled).toBe(false);
  expect(root.textContent).toContain('permit-1');
  expect(root.textContent).not.toContain('Spending needs the Owner or Admin role.');
  fetchMock.mockImplementation(defaultFetch());
  inputValue(root, '#default-group', 'personal-default');
  root.querySelector<HTMLFormElement>('.budget-form')?.requestSubmit();
  function expectSaved() {
    expect(root.querySelector('.budget-form')?.textContent).toContain('Budget saved');
  }
  await vi.waitFor(expectSaved);
  function isPost(call: Parameters<typeof fetch>) {
    return call[1]?.method === 'POST';
  }
  const posts = fetchMock.mock.calls.filter(isPost);
  expect(posts).toHaveLength(2);
  expect(parseRequestBody(posts[1]?.[1])).toMatchObject({
    ceilingCents: 45000, defaultPayingGroupId: 'personal-default',
  });
}
it('keeps the editor, typed ceiling and payer after a choice refusal and allows correction',
  correctsUnavailableChoice);

async function clearsAfterBudgetAccessRefusal() {
  function refuseAccess(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (requestUrl(input) === '/api/org/models' && init?.method === 'POST') {
      return jsonReply(403, { status: 'refused' });
    }
    return defaultFetch()(input);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(refuseAccess);
  const root = await mountScreen();
  inputValue(root, '#monthly-ceiling', '45000');
  root.querySelector<HTMLFormElement>('.budget-form')?.requestSubmit();
  function expectAccessLost() {
    expect(root.textContent).toContain('Spending needs the Owner or Admin role.');
  }
  await vi.waitFor(expectAccessLost);
  expect(root.querySelector('.budget-form')).toBeNull();
  expect(root.textContent).not.toContain('personal-default');
  expect(root.textContent).not.toContain('permit-1');
}
it('clears spending data when saving a ceiling loses Owner or Admin access',
  clearsAfterBudgetAccessRefusal);
