import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';

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

async function mount(handler: Handler): Promise<ComponentFixture<ModelsScreen>> {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input.toString();
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
  const page = fixture.nativeElement as HTMLElement;
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
  const page = fixture.nativeElement as HTMLElement;
  expect(page.textContent).toContain('No providers saved');
  expect(page.textContent).toContain('No usable models');
  expect(page.textContent).toContain('The registry lists 2 models.');
  expect(page.textContent).not.toContain('Nobody can use');
});

it('marks incomplete grants as unchecked and never invents an assistant name', async () => {
  const fixture = await mount(path => {
    if (path.endsWith('/access')) return response({ ...access, grants: [], grantTotal: 2 });
    if (path === '/api/assistants') return response({ rows: [] });
    return ordinary(path);
  });
  const page = fixture.nativeElement as HTMLElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(page.querySelector('.model-table')?.textContent).toContain('Assistant access not checked');
  });
  expect(page.querySelector('.model-table')?.textContent).toContain('Showing 0 of 2');
  expect(page.querySelector('.model-table')?.textContent).not.toContain('Helper');
});
