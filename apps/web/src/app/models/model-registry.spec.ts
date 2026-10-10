import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';
import type { ProviderRow } from './provider-api';

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  writable: true,
  value: openTestDialog,
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  writable: true,
  value: closeTestDialog,
});

const taskRouting = { chat_turn: { model: 'gpt-6.1-sol', reason: 'Chat' } };
const emptyProviderRead = { rows: [], loadedAt: '2026-10-07T09:00:00.000Z',
  access: { grantsAvailable: false, reason: 'p4_22_required' } };
const registryRead = { models: [{ id: 'gpt-6.1-sol', retired: false }], taskRouting };

function provider(providerId: string, name: string): ProviderRow {
  return { providerId, provider: 'openai', name, revision: 2, position: 2,
    saved: { changeId: `saved-${providerId}`, time: '2026-10-07T08:00:00.000Z', revision: 2,
      outcome: 'recorded' }, enabledModels: [], status: 'saved_unverified' };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}

type RequestSeen = { url: string; method: string; body: string };
type RequestHandler = (request: RequestSeen) => Response | Promise<Response>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function readRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (isRecord(parsed)) return parsed;
  throw new Error('Expected a JSON object');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function mount(handler: RequestHandler): Promise<ComponentFixture<ModelsScreen>> {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
    const url = requestUrl(input);
    const request = { url, method: options?.method ?? 'GET',
      body: typeof options?.body === 'string' ? options.body : '' };
    return Promise.resolve(handler(request));
  });
  TestBed.configureTestingModule({ imports: [ModelsScreen] });
  const fixture = TestBed.createComponent(ModelsScreen);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    const connect = screenElement(fixture).querySelector('.page-actions .button.primary');
    if (!(connect instanceof HTMLButtonElement)) throw new Error('Expected the connect button');
    expect(connect.disabled).toBe(false);
  });
  return fixture;
}

function screenElement(fixture: ComponentFixture<ModelsScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a screen element');
  return element;
}

function clickButton(fixture: ComponentFixture<ModelsScreen>, name: string): void {
  const button = [...screenElement(fixture).querySelectorAll('button')]
    .find((candidate: HTMLButtonElement) => candidate.textContent?.trim() === name);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  button.click();
  fixture.detectChanges();
}

function clickDialogButton(fixture: ComponentFixture<ModelsScreen>, name: string): void {
  const dialog = screenElement(fixture).querySelector('dialog[open]');
  if (!(dialog instanceof HTMLDialogElement)) throw new Error('Expected an open dialog');
  const button = [...dialog.querySelectorAll('button')]
    .find(matchesDialogButton(name));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing dialog button: ${name}`);
  button.click();
  fixture.detectChanges();
}

function matchesDialogButton(name: string): (candidate: HTMLButtonElement) => boolean {
  return candidate => !candidate.classList.contains('implicit-submit')
    && !candidate.classList.contains('back')
    && candidate.textContent?.includes(name) === true;
}

function field(fixture: ComponentFixture<ModelsScreen>, id: string): HTMLInputElement {
  const input = screenElement(fixture).querySelector(`#${id}`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return input;
}

async function settle(fixture: ComponentFixture<ModelsScreen>): Promise<void> {
  await fixture.whenStable();
  fixture.detectChanges();
}

async function waitForText(fixture: ComponentFixture<ModelsScreen>, text: string): Promise<void> {
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(screenElement(fixture).textContent).toContain(text);
  });
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

it('refreshes a healthy list without announcing a failure', async () => {
  let reads = 0;
  const fixture = await mount(request => {
    if (request.url === '/api/org/providers') {
      reads += 1;
      return reply({ ...emptyProviderRead, rows: [provider('one', 'Primary')] });
    }
    if (request.url === '/api/org/models') return reply(registryRead);
    throw new Error(`Unexpected request: ${request.url}`);
  });

  clickButton(fixture, 'Refresh');
  expect(screenElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Refreshing providers.');
  await settle(fixture);
  await waitForText(fixture, 'Providers and models loaded.');

  expect(reads).toBe(2);
  expect(screenElement(fixture).textContent).toContain('Primary');
  expect(screenElement(fixture).textContent).not.toContain('could not be loaded');
  expect(screenElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Providers and models loaded.');
});

it('submits the provider name once when Enter is pressed in the field', async () => {
  const commands: Record<string, unknown>[] = [];
  const fixture = await mount(request => {
    if (request.url === '/api/org/providers' && request.method === 'GET') {
      return reply(emptyProviderRead);
    }
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.url === '/api/org/providers' && request.method === 'POST') {
      commands.push(readRecord(request.body));
      const created = commands.at(-1);
      return reply({ status: 'appended', providerId: created?.['providerId'], revision: 1,
        operation: 'provider.created', sequence: 1, changeId: 'create-one' });
    }
    if (request.url.includes('/changes/')) {
      const created = commands.at(-1);
      return reply({ status: 'appended', providerId: created?.['providerId'], revision: 1,
        operation: 'provider.created', sequence: 1, changeId: created?.['commandId'],
        projection: { content: 'current', iam: 'current' } });
    }
    if (request.url.startsWith('/api/org/providers/')) {
      const created = commands.at(-1);
      return reply({ rows: [provider(String(created?.['providerId']), String(created?.['name']))] });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });

  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'Primary');
  await settle(fixture);
  await waitForText(fixture, 'Step 2 of 6');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('provider-step-title'));

  clickDialogButton(fixture, 'Back');
  await settle(fixture);
  clickDialogButton(fixture, 'Cancel');
  await settle(fixture);
  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'Secondary');
  await settle(fixture);
  await waitForText(fixture, 'Step 2 of 6');

  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ action: 'create', name: 'Primary' });
  expect(commands[1]).toMatchObject({ action: 'create', name: 'Secondary' });
  expect(commands[0]?.['commandId']).not.toBe(commands[1]?.['commandId']);
  expect(screenElement(fixture).textContent).toContain('Step 2 of 6');
});

async function submitNameWithEnter(fixture: ComponentFixture<ModelsScreen>, value: string):
Promise<void> {
  const name = field(fixture, 'provider-name');
  name.value = value;
  name.dispatchEvent(new Event('input', { bubbles: true }));
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true,
    cancelable: true }));
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true,
    cancelable: true }));
  await settle(fixture);
}

it('keeps typed key text after a lost reply and clears it after Check status confirms save',
  async () => {
    let keyPosts = 0;
    let initialReads = 0;
    const fixture = await mount(request => {
      if (request.url === '/api/org/providers' && request.method === 'GET') {
        initialReads += 1;
        const rows = initialReads === 1 ? [provider('one', 'Primary')] : [];
        return reply({ ...emptyProviderRead, rows });
      }
      if (request.url === '/api/org/models') return reply(registryRead);
      if (request.url.endsWith('/key') && request.method === 'POST') {
        keyPosts += 1;
        return reply({ status: 'unavailable' }, 503);
      }
      if (request.url.endsWith('/changes/key-save')) {
        return reply({ status: 'appended', providerId: 'one', revision: 3,
          operation: 'provider.key_saved', sequence: 3, changeId: 'saved-key',
          projection: { content: 'current', iam: 'current' }, currentRevision: 3,
          verificationValid: false });
      }
      if (request.url === '/api/org/providers/one') {
        return reply({ rows: [{ ...provider('one', 'Primary'), revision: 3,
          saved: { changeId: 'saved-key', time: '2026-10-07T09:00:00.000Z', revision: 3,
            outcome: 'recorded' } }] });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });

    clickButton(fixture, 'Replace key');
    const secret = 'private-test-token-never-echo';
    const key = field(fixture, 'replace-provider-key');
    key.value = secret;
    key.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    clickDialogButton(fixture, 'Replace key');
    await settle(fixture);
    await waitForText(fixture, 'The key outcome is unknown');

    key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true,
      cancelable: true }));
    await settle(fixture);
    expect(keyPosts).toBe(1);
    expect(field(fixture, 'replace-provider-key').type).toBe('password');
    expect(field(fixture, 'replace-provider-key').value === secret).toBe(true);
    expect(screenElement(fixture).textContent).not.toContain(secret);
    expect(screenElement(fixture).querySelector('[role="status"]')?.textContent)
      .toContain('could not tell whether key save was recorded');
    const reference = screenElement(fixture).querySelector('code')?.textContent?.trim();
    expect(reference).toBeTruthy();
    const commandStatusUrl = `/api/org/providers/one/changes/${reference}`;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, _options?: RequestInit) => {
      const url = requestUrl(input);
      if (url === commandStatusUrl) {
        return Promise.resolve(reply({ status: 'appended', providerId: 'one', revision: 3,
          operation: 'provider.key_saved', sequence: 3, changeId: reference,
          projection: { content: 'current', iam: 'current' }, currentRevision: 3,
          verificationValid: false }));
      }
      if (url === '/api/org/providers/one') {
        return Promise.resolve(reply({ rows: [{ ...provider('one', 'Primary'), revision: 3,
          saved: { changeId: 'saved-key', time: '2026-10-07T09:00:00.000Z', revision: 3,
            outcome: 'recorded' } }] }));
      }
      return Promise.resolve(reply(registryRead));
    });
    clickDialogButton(fixture, 'Check status');
    await settle(fixture);
    await waitForText(fixture, 'Key save confirmed.');

    expect(keyPosts).toBe(1);
    expect(field(fixture, 'replace-provider-key').value).toBe('');
    expect(screenElement(fixture).textContent).not.toContain(secret);
    expect(localStorage.length).toBe(0);
  });

it('lets a second provider open while the first provider has an unknown key save', async () => {
  const statusReads: string[] = [];
  const fixture = await mount(request => {
    if (request.url === '/api/org/providers' && request.method === 'GET') {
      return reply({ ...emptyProviderRead, rows: [provider('one', 'First'), provider('two', 'Second')] });
    }
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.url.endsWith('/key') && request.method === 'POST') {
      return reply({ status: 'unavailable' }, 503);
    }
    if (request.url.includes('/changes/')) {
      statusReads.push(request.url);
      return reply({ status: 'not_found' }, 404);
    }
    if (request.url === '/api/org/providers/two') {
      return reply({ rows: [provider('two', 'Second')] });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });

  const firstAction = screenElement(fixture).querySelector('.row-action');
  if (!(firstAction instanceof HTMLButtonElement)) throw new Error('First provider key action is missing');
  firstAction.click();
  fixture.detectChanges();
  const firstKey = field(fixture, 'replace-provider-key');
  firstKey.value = 'first-key';
  firstKey.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickDialogButton(fixture, 'Replace key');
  await settle(fixture);
  await waitForText(fixture, 'The key outcome is unknown');
  clickDialogButton(fixture, 'Cancel');
  fixture.detectChanges();

  const secondRow = [...screenElement(fixture).querySelectorAll('.provider-row')]
    .find(row => row.textContent?.includes('Second'));
  if (!secondRow) throw new Error('Second provider row is missing');
  const secondAction = secondRow.querySelector('.row-action');
  if (!(secondAction instanceof HTMLButtonElement)) throw new Error('Second provider action is missing');
  expect(secondAction.disabled).toBe(false);
  secondAction.click();
  await settle(fixture);

  expect(statusReads).toEqual([]);
  expect(screenElement(fixture).querySelector('dialog[open]')?.textContent).toContain('Second');
});

it('keeps typed key text when the server refuses a save', async () => {
  const fixture = await mount(request => {
    if (request.url === '/api/org/providers' && request.method === 'GET') {
      return reply({ ...emptyProviderRead, rows: [provider('one', 'Primary')] });
    }
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.url.endsWith('/key') && request.method === 'POST') {
      return reply({ status: 'refused' }, 400);
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });

  clickButton(fixture, 'Replace key');
  const secret = 'typed-value-kept-after-refusal';
  const key = field(fixture, 'replace-provider-key');
  key.value = secret;
  key.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickDialogButton(fixture, 'Replace key');
  await settle(fixture);
  await waitForText(fixture, 'The key was refused. Check the value.');

  expect(field(fixture, 'replace-provider-key').type).toBe('password');
  expect(field(fixture, 'replace-provider-key').value === secret).toBe(true);
  expect(screenElement(fixture).textContent).not.toContain(secret);
  expect(screenElement(fixture).textContent).toContain('The key was refused. Check the value.');
});

it.each([403, 404])('uses clear key-save wording for server response %s', async status => {
  const state = scenario();
  state.responseStatus = status;
  const fixture = await openScenario(state);
  clickButton(fixture, 'Replace key');
  const secret = 'fixture-key-kept-after-refusal';
  const key = field(fixture, 'replace-provider-key');
  key.value = secret;
  key.dispatchEvent(new Event('input', { bubbles: true }));
  await fixture.componentInstance['replaceKey']();
  await settle(fixture);
  const message = status === 403 ? 'The server refused this key save'
    : 'The server could not find this provider';
  const statusMessage = status === 403 ? 'The server refused this change' : message;
  expect(fixture.componentInstance['replaceKeyError']()).toContain(message);
  expect(screenElement(fixture).querySelector('dialog[open] [role="status"]')?.textContent)
    .toContain(statusMessage);
  expect(field(fixture, 'replace-provider-key').value).toBe(secret);
  expect(screenElement(fixture).textContent).not.toContain(secret);
});


it('keeps one provider after Back, an attempted name edit and Next', async () => {
  const commands: Record<string, unknown>[] = [];
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.method === 'POST') {
      commands.push(readRecord(request.body));
      return reply({ status: 'appended', revision: 1 });
    }
    if (request.url.includes('/changes/')) {
      return reply({ status: 'appended', operation: 'provider.created',
        projection: { content: 'current', iam: 'current' } });
    }
    if (request.url.startsWith('/api/org/providers/')) {
      const created = commands.at(-1);
      return reply({ rows: [provider(String(created?.['providerId']), 'Primary')] });
    }
    return reply(emptyProviderRead);
  });
  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'Primary');
  clickDialogButton(fixture, 'Back');
  await settle(fixture);
  expect(field(fixture, 'provider-name').readOnly).toBe(true);
  await submitNameWithEnter(fixture, 'Edited name');
  await settle(fixture);
  expect(commands).toHaveLength(1);
  expect(screenElement(fixture).querySelector('dialog[open]')?.textContent)
    .toContain('Step 2 of 6');
});

const statusLabels = [
  ['needs_key', 'Needs a key'],
  ['saved_unverified', 'Saved, not verified'],
  ['connected_not_tested', 'Connected, not tested'],
  ['ready', 'Model answered'],
  ['model_test_fail', 'Model test failed'],
  ['model_test_unknown', 'Model test outcome unknown'],
  ['model_test_outcome_unknown', 'Model test outcome unknown; cost may be held'],
  ['model_test_budget_refused', 'Model test refused by budget'],
];

it.each(statusLabels)('shows server status %s as %s', async (status, label) => {
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    return reply({ ...emptyProviderRead, rows: [{ ...provider('one', 'Primary'), status }] });
  });
  expect(screenElement(fixture).querySelector('.verification-fact')?.textContent).toBe(label);
});

it('keeps the key saved time after a refresh with a later load time', async () => {
  let reads = 0;
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    reads += 1;
    return reply({ ...emptyProviderRead, loadedAt: reads === 1
      ? '2026-10-07T09:00:00.000Z' : '2026-10-07T10:00:00.000Z',
      rows: [provider('one', 'Primary')] });
  });
  clickButton(fixture, 'Refresh');
  await settle(fixture);
  expect(reads).toBe(2);
  expect(screenElement(fixture).querySelector('.connection-fact')?.textContent).toContain('08:00');
  expect(screenElement(fixture).querySelector('.connection-fact')?.textContent).not.toContain('10:00');
});

it('returns focus to the row action after cancelling key replacement', async () => {
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    return reply({ ...emptyProviderRead, rows: [provider('one', 'Primary')] });
  });
  const action = screenElement(fixture).querySelector('.row-action');
  if (!(action instanceof HTMLButtonElement)) throw new Error('Missing row action');
  const bounds = [new DOMRect()];
  function item(index: number): DOMRect | null {
    return bounds[index] ?? null;
  }
  const rectangles = Object.assign(bounds, { item });
  vi.spyOn(action, 'getClientRects').mockReturnValue(rectangles);
  action.focus();
  action.click();
  await settle(fixture);
  clickDialogButton(fixture, 'Cancel');
  await settle(fixture);
  expect(document.activeElement).toBe(action);
});


it('prevents a native key form submit from putting the key in a URL', async () => {
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    return reply({ ...emptyProviderRead, rows: [provider('one', 'Primary')] });
  });
  clickButton(fixture, 'Replace key');
  const form = field(fixture, 'replace-provider-key').closest('form');
  if (!form) throw new Error('Missing key form');
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

type Scenario = {
  row: ProviderRow;
  posts: RequestSeen[];
  reads: RequestSeen[];
  statusOutcome: string;
  directOutcome: string;
  responseStatus: number;
  quoteStatus: number;
  quoteReason: string;
  reservedCents: number;
};

function scenario(): Scenario {
  return { row: provider('one', 'Primary'), posts: [], reads: [], statusOutcome: 'pass',
    directOutcome: 'pass', responseStatus: 200, quoteStatus: 200, quoteReason: '',
    reservedCents: 1 };
}

function serveScenario(state: Scenario): RequestHandler {
  return function serve(request: RequestSeen): Response {
    if (request.method === 'POST') {
      state.posts.push(request);
      if (state.responseStatus !== 200) return reply({ status: 'refused' }, state.responseStatus);
      const body = readRecord(request.body);
      const fact = { changeId: String(body['commandId']), attemptId: String(body['commandId']),
        time: '2026-10-07T09:02:00Z', revision: state.row.revision,
        outcome: state.directOutcome, model: 'gpt-6.1-sol' };
      if (body['action'] === 'reachability') state.row.reachable = fact;
      if (body['action'] === 'test' || body['action'] === 'skip') state.row.modelAnswer = fact;
      return reply({ status: 'appended', changeId: body['commandId'] });
    }
    state.reads.push(request);
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.url === '/api/org/providers') {
      return reply({ ...emptyProviderRead, rows: [state.row] });
    }
    if (request.url.includes('/verify?')) {
      if (state.quoteStatus !== 200) {
        return reply({ status: 'refused', reason: state.quoteReason }, state.quoteStatus);
      }
      return reply({ providerId: state.row.providerId, revision: state.row.revision,
        model: 'gpt-6.1-sol', priceTableId: 'price-one', reservedCents: state.reservedCents,
        consentRequired: true });
    }
    if (request.url.includes('/changes/')) {
      return reply({ status: 'appended', outcome: state.statusOutcome });
    }
    return reply({ rows: [state.row] });
  };
}

async function openScenario(state: Scenario): Promise<ComponentFixture<ModelsScreen>> {
  const fixture = await mount(serveScenario(state));
  const opener = screenElement(fixture).querySelector('.provider-row-main');
  if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing provider opener');
  await fixture.componentInstance['providerAction'](state.row, opener);
  await settle(fixture);
  return fixture;
}

function makeReachable(state: Scenario): void {
  state.row.reachable = { changeId: 'reachable', time: '2026-10-07T08:30:00Z',
    revision: state.row.revision, outcome: 'pass' };
}

function giveConsent(fixture: ComponentFixture<ModelsScreen>): void {
  const checkbox = screenElement(fixture).querySelector('.consent-row input');
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing consent');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  fixture.detectChanges();
}

function runControl(fixture: ComponentFixture<ModelsScreen>): HTMLButtonElement | null {
  return screenElement(fixture).querySelector<HTMLButtonElement>('.price-warning button.primary');
}

it.each(['reachability', 'skip', 'test'] as const)(
  'sends exactly the real verify body for %s', async action => {
    const state = scenario();
    if (action !== 'reachability') makeReachable(state);
    const fixture = await openScenario(state);
    if (action === 'test') {
      await fixture.componentInstance['loadQuote']();
      await settle(fixture);
      giveConsent(fixture);
      await fixture.componentInstance['runModelTest']();
    } else if (action === 'skip') {
      await fixture.componentInstance['skipModelTest']();
    } else {
      await fixture.componentInstance['runReachability']();
    }
    expect(state.posts).toHaveLength(1);
    const expected: Record<string, unknown> = { action, commandId: expect.any(String),
      expectedRevision: state.row.revision };
    if (action === 'test') {
      expected['model'] = 'gpt-6.1-sol';
      expected['priceTableId'] = 'price-one';
      expected['reservedCents'] = 1;
      expected['consent'] = true;
    }
    expect(readRecord(state.posts[0]?.body ?? '')).toEqual(expected);
    expect(state.posts[0]?.url).toBe('/api/org/providers/one/verify');
  });

it.each(['pass', 'fail', 'budget_refused'])(
  'consumes one consent after %s and requires a new tick before a further test', async outcome => {
    const state = scenario();
    makeReachable(state);
    state.directOutcome = outcome;
    const fixture = await openScenario(state);
    await fixture.componentInstance['loadQuote']();
    await settle(fixture);
    giveConsent(fixture);
    const first = fixture.componentInstance['runModelTest']();
    const second = fixture.componentInstance['runModelTest']();
    await Promise.all([first, second]);
    await settle(fixture);
    await fixture.componentInstance['runModelTest']();
    expect(state.posts).toHaveLength(1);
    expect(fixture.componentInstance['modelTestConsent']()).toBeUndefined();
    expect(runControl(fixture)).toBeNull();
    clickDialogButton(fixture, 'Test again');
    await settle(fixture);
    expect(runControl(fixture)?.disabled).toBe(true);
    giveConsent(fixture);
    await fixture.componentInstance['runModelTest']();
    expect(state.posts).toHaveLength(2);
  });

it('clears consent before a priced test refused because the price changed', async () => {
  const state = scenario();
  makeReachable(state);
  state.responseStatus = 409;
  const fixture = await openScenario(state);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  giveConsent(fixture);
  await fixture.componentInstance['runModelTest']();
  await settle(fixture);
  expect(state.posts).toHaveLength(1);
  expect(fixture.componentInstance['modelTestConsent']()).toBeUndefined();
  expect(runControl(fixture)?.disabled).toBe(true);
});

it('clears consent when the quote changes or a different provider opens', async () => {
  const state = scenario();
  makeReachable(state);
  const fixture = await openScenario(state);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  giveConsent(fixture);
  state.reservedCents = 40;
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  expect(runControl(fixture)?.disabled).toBe(true);
  expect(fixture.componentInstance['modelTestConsent']()).toBeUndefined();
  giveConsent(fixture);
  fixture.componentInstance['closeSetup']();
  await settle(fixture);
  state.row = { ...state.row, providerId: 'two', name: 'Second' };
  await fixture.componentInstance['load']();
  await settle(fixture);
  const opener = screenElement(fixture).querySelector('.provider-row-main');
  if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing opener');
  await fixture.componentInstance['providerAction'](state.row, opener);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  expect(runControl(fixture)?.disabled).toBe(true);
});

it.each(['outcome_unknown', 'unknown'])(
  'keeps an unfinished %s test locked and Check status only reads', async outcome => {
    const state = scenario();
    makeReachable(state);
    state.responseStatus = 503;
    state.statusOutcome = outcome;
    const fixture = await openScenario(state);
    await fixture.componentInstance['loadQuote']();
    await settle(fixture);
    giveConsent(fixture);
    await fixture.componentInstance['runModelTest']();
    await fixture.componentInstance['checkVerificationStatus']('one');
    await settle(fixture);
    expect(fixture.componentInstance['resultKind']()).toBe('unknown');
    expect(screenElement(fixture).querySelector('dialog[open]')?.textContent)
      .toContain('The cost may be held');
    expect(fixture.componentInstance['pendingChecks']()['one']?.commandId).toBeTruthy();
    await fixture.componentInstance['runModelTest']();
    await fixture.componentInstance['skipModelTest']();
    await fixture.componentInstance['runReachability']();
    expect(state.posts).toHaveLength(1);
    expect(runControl(fixture)).toBeNull();
    const back = screenElement(fixture).querySelector<HTMLButtonElement>(
      'dialog[open] .sheet-actions .button.secondary');
    expect(back?.disabled).toBe(true);
    expect(state.reads.at(-1)?.method).toBe('GET');
    state.statusOutcome = 'pass';
    await fixture.componentInstance['checkVerificationStatus']('one');
    expect(fixture.componentInstance['pendingChecks']()['one']).toBeUndefined();
  });

it('keeps the lock after a 200 receipt followed by an unknown provider fact', async () => {
  const state = scenario();
  makeReachable(state);
  state.directOutcome = 'unknown';
  const fixture = await openScenario(state);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  giveConsent(fixture);
  await fixture.componentInstance['runModelTest']();
  await settle(fixture);
  expect(fixture.componentInstance['resultKind']()).toBe('unknown');
  expect(fixture.componentInstance['pendingChecks']()['one']).toBeDefined();
  expect(runControl(fixture)).toBeNull();
  await fixture.componentInstance['runModelTest']();
  expect(state.posts).toHaveLength(1);
});

it.each(['anthropic', 'openai'] as const)(
  'moves past unchanged models for %s without sending a command', async kind => {
    const state = scenario();
    state.row.provider = kind;
    makeReachable(state);
    const fixture = await openScenario(state);
    fixture.componentInstance['nextStep']();
    await settle(fixture);
    clickDialogButton(fixture, 'Next');
    await settle(fixture);
    expect(state.posts).toHaveLength(0);
    expect(fixture.componentInstance['step']()).toBe('access');
    expect(screenElement(fixture).querySelector('.provider-list')?.textContent).toContain('Primary');
  });

it.each([400, 409, 403])('announces command refusal %s inside the modal and keeps data',
  async status => {
    const state = scenario();
    state.responseStatus = status;
    const fixture = await openScenario(state);
    await fixture.componentInstance['runReachability']();
    await settle(fixture);
    expect(screenElement(fixture).querySelector('dialog[open] [role="status"]')?.textContent)
      .toContain(status === 403 ? 'The server refused this change' : status === 409
        ? 'Provider settings changed' : 'Provider check was refused');
    expect(screenElement(fixture).querySelector('.provider-list')?.textContent).toContain('Primary');
    expect(fixture.componentInstance['loadState']()).toBe('ready');
    if (status === 403) expect(state.reads.some(isProviderListRead)).toBe(true);
  });

function isProviderListRead(request: RequestSeen): boolean {
  return request.url === '/api/org/providers' && request.method === 'GET';
}

it.each([503, 400, 409])('does not claim no price when the price read fails with %s',
  async status => {
    const state = scenario();
    makeReachable(state);
    state.quoteStatus = status;
    const fixture = await openScenario(state);
    await fixture.componentInstance['loadQuote']();
    await settle(fixture);
    expect(screenElement(fixture).querySelector('dialog[open] [role="status"]')?.textContent)
      .toContain("Couldn't read the price. Nothing was sent.");
    expect(fixture.componentInstance['commandReference']()).toBe('');
    expect(state.posts).toHaveLength(0);
  });

it('announces an unavailable price inside the modal without a command reference', async () => {
  const state = scenario();
  makeReachable(state);
  state.quoteStatus = 403;
  state.quoteReason = 'unknown_price';
  const fixture = await openScenario(state);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  expect(screenElement(fixture).querySelector('dialog[open] [role="status"]')?.textContent)
    .toContain('No price is available');
  expect(fixture.componentInstance['commandReference']()).toBe('');
});

it('clears old action messages and references on the next step', async () => {
  const state = scenario();
  const fixture = await openScenario(state);
  await fixture.componentInstance['runReachability']();
  await settle(fixture);
  expect(fixture.componentInstance['commandReference']()).not.toBe('');
  fixture.componentInstance['nextStep']();
  await settle(fixture);
  expect(fixture.componentInstance['commandReference']()).toBe('');
  expect(fixture.componentInstance['resultText']()).toBe('');
});

it('moves focus to the changed facts when reachability removes its button', async () => {
  const state = scenario();
  const fixture = await openScenario(state);
  const button = screenElement(fixture).querySelector<HTMLButtonElement>('.verify-step button');
  button?.focus();
  await fixture.componentInstance['runReachability']();
  await settle(fixture);
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('provider-step-title'));
});

it('lets a lost create start over after Check status says it was not recorded', async () => {
  let posts = 0;
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.method === 'POST') {
      posts += 1;
      return reply({ status: 'unavailable' }, 503);
    }
    if (request.url.includes('/changes/')) return reply({ status: 'not_found' }, 404);
    return reply(emptyProviderRead);
  });
  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'First');
  await fixture.componentInstance['checkCreateStatus'](fixture.componentInstance['providerIdDraft']());
  await settle(fixture);
  expect(screenElement(fixture).querySelector('dialog[open]')?.textContent).toContain('not recorded');
  clickDialogButton(fixture, 'Start over');
  await settle(fixture);
  expect(fixture.componentInstance['providerIdDraft']()).toBe('');
  expect(fixture.componentInstance['commandReference']()).toBe('');
  await submitNameWithEnter(fixture, 'Second');
  expect(posts).toBe(2);
});

it('opens a fresh draft after an uncertain create without changing its pending record', async () => {
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.method === 'POST') return reply({ status: 'unavailable' }, 503);
    return reply(emptyProviderRead);
  });
  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'First');
  const id = fixture.componentInstance['providerIdDraft']();
  const pending = fixture.componentInstance['pendingCreates']()[id];
  clickDialogButton(fixture, 'Cancel');
  await settle(fixture);
  clickButton(fixture, 'Connect a provider');
  await settle(fixture);
  expect(fixture.componentInstance['providerIdDraft']()).toBe('');
  expect(fixture.componentInstance['pendingCreates']()[id]).toEqual(pending);
  expect(screenElement(fixture).querySelector('dialog[open]')?.textContent).not.toContain('First');
});

it.each([401, 403])('clears all protected fields after a provider read returns %s', async status => {
  const state = scenario();
  makeReachable(state);
  const fixture = await openScenario(state);
  await fixture.componentInstance['loadQuote']();
  await settle(fixture);
  giveConsent(fixture);
  fixture.componentInstance['keyDraft'].set('fixture-value');
  fixture.componentInstance['replaceKeyDraft'].set('fixture-value');
  const refusedRead = function refusedRead(): Promise<Response> {
    return Promise.resolve(reply({ status: 'refused' }, status));
  };
  vi.stubGlobal('fetch', refusedRead);
  await fixture.componentInstance['load']();
  await settle(fixture);
  expect(fixture.componentInstance['providers']()).toEqual([]);
  expect(fixture.componentInstance['registry']()).toEqual([]);
  expect(fixture.componentInstance['routing']()).toEqual({});
  expect(fixture.componentInstance['selectedProvider']()).toBeUndefined();
  expect(fixture.componentInstance['quote']()).toBeUndefined();
  expect(fixture.componentInstance['modelTestConsent']()).toBeUndefined();
  expect(fixture.componentInstance['keyDraft']()).toBe('');
  expect(fixture.componentInstance['replaceKeyDraft']()).toBe('');
  expect(screenElement(fixture).querySelector('dialog[open]')).toBeNull();
});

it('keeps stale rows after a failed refresh and announces the later successful refresh', async () => {
  const state = scenario();
  const fixture = await mount(serveScenario(state));
  const refuseRead = function refuseRead(): Promise<Response> {
    return Promise.resolve(reply({ status: 'unavailable' }, 503));
  };
  vi.stubGlobal('fetch', refuseRead);
  await fixture.componentInstance['load']();
  await settle(fixture);
  expect(screenElement(fixture).querySelector('.provider-list')?.textContent).toContain('Primary');
  expect(screenElement(fixture).querySelector('[role="status"]')?.textContent).toContain('Refresh failed');
  const serve = serveScenario(state);
  vi.stubGlobal('fetch', function healthyRead(input: RequestInfo | URL): Promise<Response> {
    return Promise.resolve(serve({ url: requestUrl(input), method: 'GET', body: '' }));
  });
  await fixture.componentInstance['load']();
  await settle(fixture);
  expect(screenElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Providers and models loaded');
  expect(screenElement(fixture).querySelectorAll('.page-actions button')[0]?.textContent)
    .toContain('Refresh');
});

it('keeps model choices as typed after a lost save and blocks another selection command', async () => {
  const state = scenario();
  makeReachable(state);
  state.responseStatus = 503;
  const fixture = await openScenario(state);
  fixture.componentInstance['nextStep']();
  await settle(fixture);
  const checkbox = screenElement(fixture).querySelector('.model-choice input');
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing model choice');
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await fixture.componentInstance['saveModels']();
  await fixture.componentInstance['saveModels']();
  await settle(fixture);
  expect(checkbox.checked).toBe(true);
  expect(fixture.componentInstance['selectedModels']()).toEqual(['gpt-6.1-sol']);
  expect(fixture.componentInstance['pendingModels']()['one']).toBeDefined();
  expect(state.posts).toHaveLength(1);
});

it('never shows an empty list before the first successful read', async () => {
  const refuse = function refuse(): Promise<Response> {
    return Promise.resolve(reply({ status: 'unavailable' }, 503));
  };
  vi.stubGlobal('fetch', refuse);
  TestBed.configureTestingModule({ imports: [ModelsScreen] });
  const fixture = TestBed.createComponent(ModelsScreen);
  fixture.detectChanges();
  await waitForText(fixture, 'Provider data is unavailable');
  expect(screenElement(fixture).textContent).not.toContain('No providers saved');
  expect(screenElement(fixture).querySelectorAll('button')
    .length).toBeGreaterThan(0);
});

it('moves focus to the row action when a status receipt removes Check status', async () => {
  const state = scenario();
  const fixture = await mount(serveScenario(state));
  const pending = { one: { commandId: 'check-one', expectedRevision: 2, operation: 'test' } };
  fixture.componentInstance['pendingChecks'].set(pending);
  fixture.detectChanges();
  const status = screenElement(fixture).querySelector<HTMLButtonElement>('.row-pending button');
  if (!status) throw new Error('Missing row status button');
  status.focus();
  status.click();
  await settle(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(document.activeElement).toBe(screenElement(fixture).querySelector('.row-action'));
  });
});

it('lets an unrecorded key replacement start over only after the status read', async () => {
  const state = scenario();
  state.responseStatus = 503;
  const serve = serveScenario(state);
  const fixture = await mount(request => {
    if (request.url.includes('/changes/')) return reply({ status: 'not_found' }, 404);
    return serve(request);
  });
  clickButton(fixture, 'Replace key');
  const key = field(fixture, 'replace-provider-key');
  key.value = 'fixture-value';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  await fixture.componentInstance['replaceKey']();
  await fixture.componentInstance['checkKeyStatus']('one', true);
  await settle(fixture);
  expect(fixture.componentInstance['pendingKeys']()['one']?.notRecorded).toBe(true);
  clickDialogButton(fixture, 'Start over');
  await settle(fixture);
  expect(fixture.componentInstance['pendingKeys']()['one']).toBeUndefined();
  expect(field(fixture, 'replace-provider-key').value).toBe('');
  expect(state.posts).toHaveLength(1);
});

it('lets a free check start over after its status was not found', async () => {
  let verificationRequests = 0;
  const fixture = await mount(request => {
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.method === 'POST' && request.url.endsWith('/verify')) {
      verificationRequests += 1;
      if (verificationRequests === 1) return reply({ status: 'unavailable' }, 503);
      return reply({ status: 'appended', changeId: 'second-check' });
    }
    if (request.url.includes('/changes/')) return reply({ status: 'not_found' }, 404);
    if (request.url === '/api/org/providers') {
      return reply({ ...emptyProviderRead, rows: [provider('one', 'Primary')] });
    }
    if (request.method === 'GET' && request.url.endsWith('/verify')) {
      return reply({ status: 'pass', attemptId: 'second-check', revision: 2 });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const row = fixture.componentInstance['providers']()[0];
  if (!row) throw new Error('Missing provider');
  const opener = screenElement(fixture).querySelector('.provider-row-main');
  if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing provider opener');
  await fixture.componentInstance['providerAction'](row, opener);
  await fixture.componentInstance['runReachability']();
  await fixture.componentInstance['checkVerificationStatus']('one');
  await settle(fixture);
  expect(fixture.componentInstance['pendingChecks']()['one']?.notRecorded).toBe(true);
  clickDialogButton(fixture, 'Start over');
  expect(fixture.componentInstance['pendingChecks']()['one']).toBeUndefined();
  await fixture.componentInstance['runReachability']();
  expect(verificationRequests).toBe(2);
});

it('saves a first key at the provider revision returned by the server', async () => {
  const state = scenario();
  delete state.row.saved;
  state.row.revision = 8;
  state.responseStatus = 503;
  const fixture = await openScenario(state);
  fixture.componentInstance['keyDraft'].set('fixture-value');
  await fixture.componentInstance['saveKey']();
  expect(state.posts).toHaveLength(1);
  expect(readRecord(state.posts[0]?.body ?? '')['expectedRevision']).toBe(8);
});

it('keeps a recorded model selection locked until its records are current', async () => {
  const state = scenario();
  makeReachable(state);
  let current = false;
  const serve = serveScenario(state);
  const fixture = await mount(request => {
    if (request.url.includes('/changes/')) {
      return reply({ status: 'appended', operation: 'provider.models_selected',
        projection: { content: current ? 'current' : 'applying', iam: 'current' } });
    }
    return serve(request);
  });
  const opener = screenElement(fixture).querySelector('.provider-row-main');
  if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing opener');
  await fixture.componentInstance['providerAction'](state.row, opener);
  fixture.componentInstance['nextStep']();
  fixture.componentInstance['selectedModels'].set(['gpt-6.1-sol']);
  await fixture.componentInstance['saveModels']();
  await settle(fixture);
  expect(fixture.componentInstance['pendingModels']()['one']).toBeDefined();
  expect(fixture.componentInstance['resultKind']()).toBe('applying');
  fixture.componentInstance['previousStep']();
  expect(fixture.componentInstance['step']()).toBe('models');
  current = true;
  await fixture.componentInstance['checkModelsStatus']('one');
  await settle(fixture);
  expect(fixture.componentInstance['pendingModels']()['one']).toBeUndefined();
  expect(fixture.componentInstance['step']()).toBe('access');
  fixture.componentInstance['nextStep']();
  await settle(fixture);
  expect(screenElement(fixture).querySelector('.completion')?.textContent).toContain('Enabled models');
});

it('restores an unknown test lock from the server row when this visit has no local command', async () => {
  const state = scenario();
  makeReachable(state);
  state.statusOutcome = 'unknown';
  state.row.modelAnswer = { changeId: 'recorded-result', attemptId: 'original-test',
    time: '2026-10-07T09:00:00Z', revision: state.row.revision, outcome: 'unknown' };
  state.row.status = 'model_test_unknown';
  const fixture = await mount(serveScenario(state));
  expect(fixture.componentInstance['pendingChecks']()['one']?.commandId).toBe('original-test');
  const status = screenElement(fixture).querySelector<HTMLButtonElement>('.row-pending button');
  if (!status) throw new Error('Missing status-only action');
  status.click();
  await settle(fixture);
  expect(state.posts).toHaveLength(0);
  expect(state.reads.at(-1)?.url).toContain('/changes/original-test');
  expect(fixture.componentInstance['pendingChecks']()['one']).toBeDefined();
});

it('keeps the same provider open while a confirmed key change reads its updated row', async () => {
  const first = provider('one', 'Primary');
  const second = provider('two', 'Second');
  let readStarted = false;
  let releaseRead: ((response: Response) => void) | undefined;
  function storeRelease(resolve: (response: Response) => void): void {
    releaseRead = resolve;
  }
  const updatedRow = new Promise<Response>(storeRelease);
  function serve(request: RequestSeen): Response | Promise<Response> {
    if (request.url === '/api/org/models') return reply(registryRead);
    if (request.url === '/api/org/providers') {
      return reply({ ...emptyProviderRead, rows: [first, second] });
    }
    if (request.method === 'POST') {
      return reply({ status: 'appended', changeId: 'saved-key' });
    }
    if (request.url.includes('/changes/')) {
      return reply({ status: 'appended', operation: 'provider.key_saved',
        projection: { content: 'current', iam: 'current' } });
    }
    readStarted = true;
    return updatedRow;
  }
  const fixture = await mount(serve);
  clickButton(fixture, 'Replace key');
  const key = field(fixture, 'replace-provider-key');
  key.value = 'fixture-key';
  key.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  clickDialogButton(fixture, 'Replace key');
  function readWasStarted(): void {
    fixture.detectChanges();
    expect(readStarted).toBe(true);
  }
  await vi.waitFor(readWasStarted);
  try {
    const cancel = screenElement(fixture).querySelector<HTMLButtonElement>(
      'dialog[open] .sheet-actions button.secondary');
    expect(cancel?.disabled).toBe(true);
    cancel?.click();
    const opener = screenElement(fixture).querySelector('.page-actions .button.primary');
    if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing provider opener');
    fixture.componentInstance['startReplacement'](second, opener);
    expect(fixture.componentInstance['replaceProviderId']()).toBe('one');
  } finally {
    releaseRead?.(reply({ rows: [first] }));
    await settle(fixture);
  }
});

type PendingRequestAction = 'create' | 'key' | 'models' | 'quote';
const pendingRequestMessages: Record<PendingRequestAction, string> = {
  create: 'Sending provider name.',
  key: 'Sending key save.',
  models: 'Sending model choices.',
  quote: 'Reading the current price.',
};

async function startPendingRequest(
  action: PendingRequestAction, fixture: ComponentFixture<ModelsScreen>, row: ProviderRow,
): Promise<void> {
  const opener = screenElement(fixture).querySelector('.page-actions .button.primary');
  if (!(opener instanceof HTMLButtonElement)) throw new Error('Missing provider opener');
  if (action === 'create') {
    fixture.componentInstance['openSetup'](opener);
    const draft = { provider: 'openai' as const, name: 'New provider' };
    fixture.componentInstance['draft'].set(draft);
    fixture.detectChanges();
    await fixture.componentInstance['createProvider']();
    return;
  }
  await fixture.componentInstance['providerAction'](row, opener);
  if (action === 'key') {
    fixture.componentInstance['previousStep']();
    fixture.componentInstance['keyDraft'].set('fixture-key');
    await fixture.componentInstance['saveKey']();
  } else if (action === 'models') {
    fixture.componentInstance['nextStep']();
    fixture.componentInstance['selectedModels'].set(['gpt-6.1-sol']);
    await fixture.componentInstance['saveModels']();
  } else {
    await fixture.componentInstance['loadQuote']();
  }
}

it.each(['create', 'key', 'models', 'quote'] as const)(
  'announces the pending %s request inside the modal before its reply', async action => {
    const state = scenario();
    makeReachable(state);
    const normalReply = serveScenario(state);
    let sent = false;
    let release: ((response: Response) => void) | undefined;
    function storeRelease(resolve: (response: Response) => void): void {
      release = resolve;
    }
    const pendingReply = new Promise<Response>(storeRelease);
    function serve(request: RequestSeen): Response | Promise<Response> {
      if (request.method === 'POST' || request.url.includes('/verify?')) {
        sent = true;
        return pendingReply;
      }
      return normalReply(request);
    }
    const fixture = await mount(serve);
    const pending = startPendingRequest(action, fixture, state.row);
    function requestWasSent(): void {
      fixture.detectChanges();
      expect(sent).toBe(true);
    }
    await vi.waitFor(requestWasSent);
    try {
      const status = screenElement(fixture).querySelector('dialog[open] [role="status"]');
      expect(status?.textContent).toContain(pendingRequestMessages[action]);
    } finally {
      release?.(reply({ status: 'unavailable' }, 503));
      await pending;
      await settle(fixture);
    }
  });

function openTestDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeTestDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
}

function replacesDialogMethodsForAnotherComponent() {
  const dialog = document.createElement('dialog');
  const showModal = vi.fn(openTestDialog);
  const close = vi.fn(closeTestDialog);
  const methods = { showModal, close };
  Object.assign(dialog, methods);
  dialog.showModal();
  expect(showModal).toHaveBeenCalledOnce();
  expect(dialog.open).toBe(true);
  dialog.close();
  expect(close).toHaveBeenCalledOnce();
  expect(dialog.open).toBe(false);
}
it('lets another component replace dialog methods on its own element',
  replacesDialogMethodsForAnotherComponent);
