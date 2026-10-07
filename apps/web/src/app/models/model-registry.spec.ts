import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';
import type { ProviderRow } from './provider-api';

Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value: function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  value: function close(this: HTMLDialogElement): void { this.removeAttribute('open'); },
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
  await waitForText(fixture, 'Providers loaded.');

  expect(reads).toBe(2);
  expect(screenElement(fixture).textContent).toContain('Primary');
  expect(screenElement(fixture).textContent).not.toContain('could not be loaded');
  expect(screenElement(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('Providers loaded.');
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
  await waitForText(fixture, 'Save the provider key');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('provider-step-title'));

  clickDialogButton(fixture, 'Back');
  await settle(fixture);
  clickDialogButton(fixture, 'Cancel');
  await settle(fixture);
  clickButton(fixture, 'Connect a provider');
  await submitNameWithEnter(fixture, 'Secondary');
  await settle(fixture);
  await waitForText(fixture, 'Save the provider key');

  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ action: 'create', name: 'Primary' });
  expect(commands[1]).toMatchObject({ action: 'create', name: 'Secondary' });
  expect(commands[0]?.['commandId']).not.toBe(commands[1]?.['commandId']);
  expect(screenElement(fixture).textContent).toContain('Save the provider key');
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
    .toContain('Save the provider key');
});

const statusLabels = [
  ['needs_key', 'Needs a key'],
  ['saved_unverified', 'Saved, not verified'],
  ['connected_not_tested', 'Connected, not tested'],
  ['ready', 'Model answered'],
  ['model_test_fail', 'Model test failed'],
  ['model_test_unknown', 'Model test outcome unknown'],
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
