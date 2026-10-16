import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsScreen } from './model-registry';
import { ProviderSetupAccess } from './provider-setup-access';

const time = '2026-10-14T09:00:00Z';
const unavailable = { status: 'not_available_yet' };
const fact = { changeId: 'saved', time, revision: 2, outcome: 'pass' };
const provider = { providerId: 'provider', provider: 'openai', name: 'Connection',
  revision: 2, position: 2, saved: fact, reachable: fact,
  modelAnswer: { ...fact, outcome: 'skipped' }, enabledModels: [], status: 'ready' };
const grant = { granteeKind: 'team', granteeId: 'team', displayName: 'Sales', source: 'group',
  state: 'granted', eventId: 'grant', eventTime: time, sequence: 4, projection: 'current' };
type Failure = { code: number; status: string };
let failure: Failure | undefined;
let statusProjection = 'current';
let modelsSaved = false;
const delayed = new Map<string, Promise<Response>>();
let fixture: ComponentFixture<ModelsScreen>;
let requests: { url: string; body: Record<string, unknown> | undefined }[];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}
function serve(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  let url: string;
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.href;
  else url = input.url;
  let body: Record<string, unknown> | undefined;
  if (typeof options?.body === 'string') {
    const parsed: unknown = JSON.parse(options.body);
    if (!isRecord(parsed)) throw new Error('Expected a command object');
    body = parsed;
  }
  requests.push({ url, body });
  const pending = delayed.get(url);
  if (pending) return pending;
  if (url.includes('/candidates')) {
    const memberCount = url.includes('kind=team') ? 12 : undefined;
    return Promise.resolve(response({ rows: [{ id: 'assistant', displayName: 'Helper', memberCount }],
      next: null, loadedAt: time, projection: { content: 'current', sequence: 4 } }));
  }
  if (url.includes('/access')) {
    const modelId = url.split('/')[4];
    if (modelId === 'model-b' && (body || url.includes('/changes/'))) {
      if (failure) return Promise.resolve(response({ status: failure.status }, failure.code));
      if (body) return Promise.reject(new Error('Lost reply'));
    }
    const receipt = { status: 'appended', modelId, commandId: body?.['commandId'],
      operation: 'grant.given', sequence: 9, changeId: 'grant-change' };
    if (body) return Promise.resolve(response(receipt));
    if (url.includes('/changes/')) {
      return Promise.resolve(response({ ...receipt, commandId: url.split('/').at(-1),
        currentSequence: 9, projection: { content: 'current', iam: statusProjection } }));
    }
    let expectedSequence = 12;
    if (modelId === 'model-a') {
      expectedSequence = requests.some(isFirstModelPost) ? 9 : 8;
    }
    return Promise.resolve(response({ modelId, expectedSequence,
      loadedAt: time, canManage: true, grants: [grant], grantTotal: 1,
      explanations: { configuredUses: unavailable },
      projection: { content: 'current', sequence: expectedSequence },
      availability: { registrySupported: true, selectedConnection: unavailable,
        enabledModel: unavailable, connection: unavailable, key: unavailable,
        verification: unavailable } }));
  }
  if (url === '/api/org/models') {
    return Promise.resolve(response({ models: [{ id: 'model-a' }, { id: 'model-b' },
      { id: 'not-selected' }], taskRouting: {} }));
  }
  if (body || url.includes('/changes/')) {
    modelsSaved = true;
    return Promise.resolve(response({ status: 'appended', operation: 'provider.models_selected',
      projection: { content: 'current', iam: 'current' } }));
  }
  const enabledModels = modelsSaved ? ['model-a', 'model-b'] : [];
  return Promise.resolve(response({ rows: [{ ...provider, enabledModels }], loadedAt: time,
    access: { grantsAvailable: true, reason: 'model_access_routes' } }));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function element(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Expected an element');
  return value;
}
function root(): HTMLElement {
  return element(fixture.nativeElement);
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
async function mount(mode?: Failure): Promise<void> {
  requests = [];
  failure = mode;
  delayed.clear();
  statusProjection = 'current';
  modelsSaved = false;
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
function isFirstModelPost(request: { url: string; body: unknown }): boolean {
  return request.url === '/api/org/models/model-a/access' && !!request.body;
}
function isAccessPost(request: { url: string; body: unknown }): boolean {
  return request.url.endsWith('/access') && !!request.body;
}
it('keeps each receipt separate and ticks only a confirmed grant on Done', partialSaves);


async function recovery(mode: Failure, message: string, action: string): Promise<void> {
  await mount(mode);
  const editors = root().querySelectorAll('oc-provider-setup-access oc-model-access-editor');
  const editor = editors[1];
  if (!editor) throw new Error('Expected second model');
  await click('Assistant', editor);
  await click('Grant', editor);
  await click('Save access', editor);
  expect(editor.textContent).toContain(message);
  expect(editors[0]?.textContent).not.toContain(message);
  const before = requests.filter(isAccessPost);
  if (action) await click(action, editor);
  const after = requests.filter(isAccessPost);
  expect(after).toHaveLength(action === 'Try again' ? 2 : 1);
  if (action === 'Try again') expect(after[1]?.body).toEqual(before[0]?.body);
  await click('Next');
  expect(root().querySelector('.completion')?.textContent).toContain('Helper still lacks model-b');
  expect(root().querySelector('.completion')?.textContent).not.toContain('✓ Helper');
}
it('requires review after a conflict without resending or affecting the other model',
  recovery.bind(null, { code: 409, status: 'refused' }, 'Review', 'Refresh'));
it('offers only the identical retry for a proved unavailable append',
  recovery.bind(null, { code: 503, status: 'unavailable' }, 'Nothing changed', 'Try again'));
it('only reads status for 503 unknown',
  recovery.bind(null, { code: 503, status: 'unknown' }, 'Outcome unknown', 'Check status'));
it('only reads status for 404 unknown',
  recovery.bind(null, { code: 404, status: 'unknown' }, 'Outcome unknown', 'Check status'));
it('keeps an assistant missing when nothing was changed',
  recovery.bind(null, { code: 200, status: 'no_effect' }, 'Nothing to remove', ''));

async function unconfirmedAssistant(save: boolean): Promise<void> {
  await mount();
  statusProjection = 'applying';
  const editor = root().querySelector('oc-provider-setup-access oc-model-access-editor');
  if (!editor) throw new Error('Expected first model');
  await click('Assistant', editor);
  await click('Grant', editor);
  if (save) await click('Save access', editor);
  await click('Next');
  const done = root().querySelector('.completion');
  expect(done?.textContent).toContain('Helper still lacks model-a');
  expect(done?.textContent).not.toContain('✓ Helper');
}
it('keeps an applying assistant missing on Done', unconfirmedAssistant.bind(null, true));
it('keeps an unsaved assistant missing on Done', unconfirmedAssistant.bind(null, false));

async function deniedRead(code: number): Promise<void> {
  await mount();
  let release!: (value: Response) => void;
  function hold(resolve: (value: Response) => void): void { release = resolve; }
  const late = new Promise<Response>(hold);
  delayed.set('/api/org/models/model-b/access/candidates?kind=assistant&limit=50', late);
  const editors = root().querySelectorAll('oc-provider-setup-access oc-model-access-editor');
  await click('Assistant', editors[1]);
  const refused = Promise.resolve(response({}, code));
  delayed.set('/api/org/models/model-a/access/candidates?kind=assistant&limit=50', refused);
  await click('Assistant', editors[0]);
  release(response({ rows: [{ id: 'late', displayName: 'Late name' }], next: null,
    loadedAt: time, projection: { content: 'current', sequence: 4 } }));
  await settle();
  expect(root().querySelector('oc-provider-setup-access')).toBeNull();
  expect(root().textContent).not.toContain('Sales');
  expect(root().textContent).not.toContain('Late name');
  expect(sessionStorage.length).toBe(0);
}
it('clears setup on 401 and ignores a late successful candidate reply', deniedRead.bind(null, 401));
it('clears setup on 403 and ignores a late successful candidate reply', deniedRead.bind(null, 403));


function onlyRealFacts(): void {
  TestBed.configureTestingModule({ imports: [ProviderSetupAccess] });
  const view = TestBed.createComponent(ProviderSetupAccess);
  const content = element(view.nativeElement);
  view.componentRef.setInput('models', ['model-a']);
  view.componentRef.setInput('provider', { ...provider, modelAnswer: undefined });
  view.componentRef.setInput('done', true);
  view.detectChanges();
  expect(content.textContent).toContain('Not tested');
  expect(content.textContent).not.toContain('Enabled models');
  expect(content.textContent).not.toContain('✓ Helper');
  view.componentRef.setInput('modelsCurrent', true);
  view.detectChanges();
  expect(content.textContent).toContain('Enabled models: 1');
}
it('waits for the models receipt and never invents a test or grant receipt', onlyRealFacts);


async function candidateCountAndRevoke(): Promise<void> {
  await mount();
  const editor = root().querySelector('oc-provider-setup-access oc-model-access-editor');
  if (!editor) throw new Error('Expected first model');
  expect(editor.querySelector('.chips')?.textContent).not.toContain('people');
  await click('Group', editor);
  await click('Grant', editor);
  expect(editor.querySelector('.chips')?.textContent).toContain('12 people');
  await click('×', editor);
  await click('Save access', editor);
  const posts = requests.filter(isAccessPost);
  expect(posts[0]?.body?.['action']).toBe('revoke');
  expect(posts[0]?.body?.['granteeId']).toBe('team');
}
it('uses candidate counts only and selects a revoke with the chip cross', candidateCountAndRevoke);
