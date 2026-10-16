import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';

const time = '2026-10-14T09:00:00Z';
const unavailable = { status: 'not_available_yet' };
const fact = { changeId: 'saved', time, revision: 2, outcome: 'pass' };
const provider = { providerId: 'provider', provider: 'openai', name: 'Connection',
  revision: 2, position: 2, saved: fact, reachable: fact,
  modelAnswer: { ...fact, outcome: 'skipped' }, enabledModels: [], status: 'ready' };
const grant = { granteeKind: 'team', granteeId: 'team', displayName: 'Sales', source: 'group',
  state: 'granted', eventId: 'grant', eventTime: time, sequence: 4, projection: 'current' };
let fixture: ComponentFixture<ModelsScreen>;
let requests: { url: string; body: Record<string, unknown> | undefined }[];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}
function serve(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = typeof options?.body === 'string'
    ? JSON.parse(options.body) as Record<string, unknown> : undefined;
  requests.push({ url, body });
  if (url.includes('/candidates')) {
    return Promise.resolve(response({ rows: [{ id: 'assistant', displayName: 'Helper' }],
      next: null, loadedAt: time, projection: { content: 'current', sequence: 4 } }));
  }
  if (url.includes('/access')) {
    const modelId = url.split('/')[4];
    if (body && modelId === 'model-b') return Promise.reject(new Error('Lost reply'));
    const receipt = { status: 'appended', modelId, commandId: body?.['commandId'],
      operation: 'grant.given', sequence: 8, changeId: 'grant-change' };
    if (body) return Promise.resolve(response(receipt));
    if (url.includes('/changes/')) {
      return Promise.resolve(response({ ...receipt, commandId: url.split('/').at(-1),
        currentSequence: 8, projection: { content: 'current', iam: 'current' } }));
    }
    return Promise.resolve(response({ modelId, expectedSequence: modelId === 'model-a' ? 8 : 12,
      loadedAt: time, canManage: true, grants: [grant], grantTotal: 1,
      explanations: { configuredUses: unavailable }, projection: { content: 'current', sequence: 8 },
      availability: { registrySupported: true, selectedConnection: unavailable,
        enabledModel: unavailable, connection: unavailable, key: unavailable,
        verification: unavailable } }));
  }
  if (url === '/api/org/models') {
    return Promise.resolve(response({ models: [{ id: 'model-a' }, { id: 'model-b' },
      { id: 'not-selected' }], taskRouting: {} }));
  }
  if (body || url.includes('/changes/')) {
    return Promise.resolve(response({ status: 'appended', operation: 'provider.models_selected',
      projection: { content: 'current', iam: 'current' } }));
  }
  return Promise.resolve(response({ rows: [provider], loadedAt: time,
    access: { grantsAvailable: true, reason: 'model_access_routes' } }));
}
function root(): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}
function nextTask(resolve: () => void): void { setTimeout(resolve, 0); }
async function settle(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    fixture.detectChanges();
    await new Promise<void>(nextTask);
    await fixture.whenStable();
  }
  fixture.detectChanges();
}
async function click(name: string, scope: Element = root()): Promise<void> {
  for (const button of scope.querySelectorAll('button')) {
    if (button.textContent?.trim() !== name) continue;
    button.click();
    await settle();
    return;
  }
  throw new Error(`Missing button: ${name}`);
}
function openDialog(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeDialog(this: HTMLDialogElement): void { this.removeAttribute('open'); }
async function mount(): Promise<void> {
  requests = [];
  vi.stubGlobal('fetch', serve);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, writable: true, value: openDialog,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true, writable: true, value: closeDialog,
  });
  TestBed.configureTestingModule({ imports: [ModelsScreen] });
  fixture = TestBed.createComponent(ModelsScreen);
  fixture.detectChanges();
  await settle();
  root().querySelector<HTMLButtonElement>('.provider-row-main')?.click();
  await settle();
  await click('Next');
  const choices = root().querySelectorAll<HTMLInputElement>('.model-choice input');
  choices[0]?.click();
  choices[1]?.click();
  await settle();
  await click('Next');
  expect(root().textContent).toContain('Step 5 of 6');
}
function cleanUp(): void {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
  sessionStorage.clear();
}
afterEach(cleanUp);

async function selectedModelsOnly(): Promise<void> {
  await mount();
  const editors = root().querySelectorAll('oc-provider-setup-access oc-model-access-editor');
  expect(editors).toHaveLength(2);
  expect(editors[0]?.textContent).toContain('Sales');
  expect(editors[0]?.textContent).toContain('Group');
  const reads = requests.filter(isAccessRead);
  expect(reads).toEqual([{ url: '/api/org/models/model-a/access', body: undefined },
    { url: '/api/org/models/model-b/access', body: undefined }]);
}
function isAccessRead(request: { url: string }): boolean { return request.url.endsWith('/access'); }
it('reads each selected model once and shows only returned grant chips', selectedModelsOnly);

async function partialSaves(): Promise<void> {
  await mount();
  const editors = root().querySelectorAll('oc-provider-setup-access oc-model-access-editor');
  expect(editors).toHaveLength(2);
  for (const editor of editors) {
    await click('Assistant', editor);
    await click('Grant', editor);
    expect(editor.parentElement?.textContent).toContain('Helper has no grant yet');
    await click('Save access', editor);
  }
  expect(editors[0]?.textContent).toContain('Saved');
  expect(editors[1]?.textContent).toContain('Outcome unknown');
  expect(editors[1]?.textContent).not.toContain('Try again');
  const posts = requests.filter(isAccessPost);
  expect(posts).toHaveLength(2);
  expect(posts[0]?.body?.['expectedSequence']).toBe(8);
  expect(posts[1]?.body?.['expectedSequence']).toBe(12);
  expect(posts[0]?.body?.['commandId']).not.toBe(posts[1]?.body?.['commandId']);
  expect(sessionStorage.length).toBe(0);
  await click('Next');
  const done = root().querySelector('.completion');
  expect(done?.textContent).toContain('✓ Helper — model-a');
  expect(done?.textContent).not.toContain('✓ Helper — model-b');
  expect(done?.textContent).toContain('⚠ Helper still lacks model-b. Grant it in Models.');
  expect(done?.textContent).toContain('Connected, not tested');
  expect(done?.textContent).not.toContain('complete');
}
function isAccessPost(request: { url: string; body: unknown }): boolean {
  return request.url.endsWith('/access') && !!request.body;
}
it('keeps each receipt separate and ticks only a confirmed grant on Done', partialSaves);
