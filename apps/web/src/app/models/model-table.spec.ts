import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';

function showDialog(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeDialog(this: HTMLDialogElement): void { this.removeAttribute('open'); }
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
  writable: true, value: showDialog });
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
  writable: true, value: closeDialog });

const time = '2026-10-14T09:00:00Z';
const model = 'gpt-6.1-sol';
const unavailable = { status: 'not_available_yet' };
const registry = { models: [{ id: model }, { id: 'gpt-6-astra' }], taskRouting: {
  chat_turn: { model, reason: 'Chat' }, demanding_task: { model: 'gpt-6-astra', reason: 'Hard' },
} };
const provider = { providerId: 'first', provider: 'openai', name: 'Primary', revision: 2,
  position: 2, enabledModels: [model], status: 'saved_unverified' };
const providers = { rows: [provider], loadedAt: time,
  access: { grantsAvailable: true, reason: 'model_access_routes' } };
const grant = { granteeKind: 'team', granteeId: 'sales', displayName: 'Sales', source: 'group',
  state: 'granted', eventId: 'grant-one', eventTime: time, sequence: 4, projection: 'current' };
const access = { modelId: model, expectedSequence: 4, loadedAt: time, canManage: true,
  grants: [grant], grantTotal: 1, explanations: { configuredUses: unavailable },
  availability: { registrySupported: true, selectedConnection: unavailable,
    enabledModel: unavailable, connection: unavailable, key: unavailable,
    verification: unavailable }, projection: { content: 'current', sequence: 4 } };
const binding = { providerId: 'first', revision: 2, changedBy: 'owner', kind: 'assistant',
  dependantId: 'helper', task: 'chat_turn', expectedProviderSequence: 2,
  previousBindingSequence: 0, state: 'active', model, assistantCount: 1 };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type Handler = (path: string) => Response | Promise<Response>;

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function screenElement(fixture: ComponentFixture<ModelsScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a screen element');
  return element;
}

async function mount(handler: Handler): Promise<ComponentFixture<ModelsScreen>> {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const path = requestPath(input);
    return Promise.resolve(handler(path));
  });
  TestBed.configureTestingModule({ imports: [ModelsScreen] });
  const fixture = TestBed.createComponent(ModelsScreen);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.componentInstance['loadState']()).toBe('ready');
  });
  return fixture;
}

function ordinary(path: string): Response {
  if (path === '/api/org/providers') return response(providers);
  if (path === '/api/org/models') return response(registry);
  if (path === '/api/assistants') return response({ rows: [{ assistantId: 'helper', name: 'Helper' }] });
  if (path.endsWith('/bindings')) return response({ rows: [binding] });
  if (path.endsWith('/access')) return response(access);
  throw new Error(`Unexpected GET: ${path}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

it('shows enabled registry rows, route words, grant sources and the registry footer', async () => {
  const seen: string[] = [];
  const fixture = await mount(path => {
    seen.push(path);
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('Sales');
  });
  const table = page.querySelector('.model-table');
  expect(table?.textContent).toContain('OpenAI · Primary');
  expect(table?.textContent).toContain('chat turn');
  expect(table?.textContent).toContain('group');
  expect(table?.textContent).toContain('⚠ Enabled · not usable by Helper');
  expect(table?.textContent).toContain('Showing 1 of 2 registry models');
  expect(seen.filter(path => path.endsWith('/access'))).toEqual([`/api/org/models/${model}/access`]);
  expect(seen.filter(path => path.endsWith('/bindings'))).toEqual(['/api/org/providers/first/bindings']);
});

it('keeps complete emptiness separate from provider emptiness', async () => {
  const fixture = await mount(path => {
    if (path === '/api/org/providers') return response({ ...providers, rows: [] });
    return ordinary(path);
  });
  const page = screenElement(fixture);
  expect(page.textContent).toContain('No providers saved');
  expect(page.textContent).toContain('No usable models');
  expect(page.textContent).toContain('The registry lists 2 models.');
  expect(page.textContent).not.toContain('Nobody can use');
});

it('calls Anthropic unsupported without counting OpenAI registry models for it', async () => {
  const fixture = await mount(path => {
    if (path === '/api/org/providers') {
      const anthropic = { ...provider, provider: 'anthropic', enabledModels: [] };
      return response({ ...providers, rows: [anthropic] });
    }
    return ordinary(path);
  });
  const page = screenElement(fixture);
  expect(page.querySelector('.provider-list')?.textContent).toContain('No supported models');
  expect(page.querySelector('.provider-list')?.textContent).not.toContain('0 enabled of 2');
  expect(page.textContent).toContain('No usable models');
});

it('marks incomplete grants as unchecked and never invents an assistant name', async () => {
  const fixture = await mount(path => {
    if (path.endsWith('/access')) return response({ ...access, grants: [], grantTotal: 2 });
    if (path === '/api/assistants') return response({ rows: [] });
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('Assistant access not checked');
  });
  expect(page.querySelector('.model-table')?.textContent).toContain('Showing 0 of 2');
  expect(page.querySelector('.model-table')?.textContent).not.toContain('Helper');
});

it.each(['/bindings', '/api/assistants'])('marks a failed %s read as unchecked',
  async failedPath => {
    const fixture = await mount(path => {
      if (path.endsWith(failedPath)) return response({}, 503);
      return ordinary(path);
    });
    const page = screenElement(fixture);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('.model-table')?.textContent)
        .toContain('Assistant access not checked');
    });
    expect(page.querySelector('.model-table')?.textContent).not.toContain('not usable by');
  });

it('does not guess a name when a configured assistant has none in the reply', async () => {
  const fixture = await mount(path => {
    if (path === '/api/assistants') return response({ rows: [{ assistantId: 'helper' }] });
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent)
      .toContain('Assistant access not checked');
  });
  expect(page.querySelector('.model-table')?.textContent).not.toContain('not usable by');
});

it('hides revoked rows and only says No audience for a complete list', async () => {
  const revoked = { ...grant, state: 'revoked' };
  const fixture = await mount(path => {
    if (path.endsWith('/access')) return response({ ...access, grants: [revoked] });
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('No audience');
  });
  expect(page.querySelector('.model-table')?.textContent).not.toContain('Sales');
});

it('labels direct and assistant grants and an applying row from the access reply', async () => {
  const direct = { ...grant, granteeKind: 'member', granteeId: 'alice',
    displayName: 'Alice', source: 'direct', projection: 'applying' };
  const assistant = { ...grant, granteeKind: 'assistant', granteeId: 'helper',
    displayName: 'Helper', source: 'assistant' };
  const fixture = await mount(path => {
    if (path.endsWith('/access')) {
      return response({ ...access, grants: [direct, assistant], grantTotal: 2 });
    }
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('Alice (direct)');
  });
  expect(page.querySelector('.model-table')?.textContent).toContain('Helper (assistant)');
  expect(page.querySelector('.model-table')?.textContent).toContain('applying');
});

it.each(['own', 'default'])('warns for a named assistant using the %s binding', async kind => {
  const selected = kind === 'own' ? binding : { ...binding, kind: 'silo_default',
    dependantId: 'silo' };
  const fixture = await mount(path => {
    if (path.endsWith('/bindings')) return response({ rows: [selected] });
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('not usable by Helper');
  });
});

it.each(['paused', 'granted'])('keeps Enabled for %s assistant access', async caseName => {
  const fixture = await mount(path => {
    if (caseName === 'paused' && path.endsWith('/bindings')) {
      return response({ rows: [{ ...binding, state: 'paused' }] });
    }
    if (caseName === 'granted' && path.endsWith('/access')) {
      const assistantGrant = { ...grant, granteeKind: 'assistant', granteeId: 'helper',
        displayName: 'Helper', source: 'assistant' };
      return response({ ...access, grants: [grant, assistantGrant], grantTotal: 2 });
    }
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    const content = page.querySelector('.model-table')?.textContent ?? '';
    expect(content).toContain('✓ Enabled');
    expect(content).not.toContain('Assistant access not checked');
  });
  expect(page.querySelector('.model-table')?.textContent).not.toContain('not usable');
});

it('keeps a loaded row after a failed refresh and locks provider actions', async () => {
  let fail = false;
  const methods: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
    const path = requestPath(input);
    methods.push(options?.method ?? 'GET');
    if (fail && path === '/api/org/providers') return response({}, 503);
    return ordinary(path);
  });
  TestBed.configureTestingModule({ imports: [ModelsScreen] });
  const fixture = TestBed.createComponent(ModelsScreen);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.componentInstance['loadState']()).toBe('ready');
  });
  fail = true;
  const page = screenElement(fixture);
  const refresh = page.querySelector('.page-actions button');
  if (!(refresh instanceof HTMLButtonElement)) throw new Error('Refresh is missing');
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.textContent).toContain('Showing the last data loaded at');
  });
  expect(page.querySelector('.model-table')?.textContent).toContain(model);
  const providerRow = page.querySelector('.provider-row-main');
  if (!(providerRow instanceof HTMLButtonElement)) throw new Error('Provider row is missing');
  expect(providerRow.disabled).toBe(true);
  expect(methods.every(method => method === 'GET')).toBe(true);
});

it.each([401, 403])('clears every row on a %s while another new read is pending', async code => {
  let deny = false;
  let releaseBinding: ((reply: Response) => void) | undefined;
  const fixture = await mount(path => {
    if (deny && path.endsWith('/bindings')) {
      return new Promise<Response>(resolve => { releaseBinding = resolve; });
    }
    if (deny && path.endsWith('/access')) return response({}, code);
    return ordinary(path);
  });
  const page = screenElement(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('Sales');
  });
  deny = true;
  const refresh = page.querySelector('.page-actions button');
  if (!(refresh instanceof HTMLButtonElement)) throw new Error('Refresh is missing');
  refresh.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')).toBeNull();
  });
  releaseBinding?.(response({ rows: [binding] }));
  await Promise.resolve();
  fixture.detectChanges();
  expect(page.textContent).not.toContain('Sales');
  expect(page.textContent).not.toContain('Helper');
  expect(fixture.componentInstance['loadState']()).toBe(code === 401 ? 'access' : 'forbidden');
});

it('has one loading announcement, no sample rows and returns focus after Access closes',
  async () => {
    let finishProviders: ((reply: Response) => void) | undefined;
    let finishRegistry: ((reply: Response) => void) | undefined;
    let accessReads = 0;
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/api/org/providers') {
        return new Promise<Response>(resolve => { finishProviders = resolve; });
      }
      if (path === '/api/org/models') {
        return new Promise<Response>(resolve => { finishRegistry = resolve; });
      }
      if (path.endsWith('/access')) accessReads++;
      return ordinary(path);
    });
    TestBed.configureTestingModule({ imports: [ModelsScreen] });
    const fixture = TestBed.createComponent(ModelsScreen);
    fixture.detectChanges();
    const page = screenElement(fixture);
    expect(page.querySelectorAll('.provider-page > [role="status"]')).toHaveLength(1);
    expect(page.querySelector('.model-table')).toBeNull();
    finishProviders?.(response(providers));
    finishRegistry?.(response(registry));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('.model-table')).not.toBeNull();
    });
    const opener = page.querySelector('.model-table .model-access');
    if (!(opener instanceof HTMLButtonElement)) throw new Error('Access is missing');
    // Give jsdom a layout box so the browser's focus return can be checked.
    const box = opener.getBoundingClientRect();
    function boxAt(index: number): DOMRect | null { return index === 0 ? box : null; }
    const boxes = Object.assign([box], { item: boxAt });
    vi.spyOn(opener, 'getClientRects').mockReturnValue(boxes);
    opener.focus();
    opener.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(page.querySelector('dialog[open]')).not.toBeNull();
    });
    const back = page.querySelector('dialog[open] button.back');
    if (!(back instanceof HTMLButtonElement)) throw new Error('Back is missing');
    back.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(opener);
      expect(accessReads).toBe(3);
    });
  });
