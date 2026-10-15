import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelAccessEditor } from './model-access-editor';

function openDialog(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeDialog(this: HTMLDialogElement): void { this.removeAttribute('open'); }
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true, writable: true, value: openDialog,
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true, writable: true, value: closeDialog,
});

const modelId = 'gpt-6.1-sol';
const base = `/api/org/models/${modelId}/access`;
const key = `model-access:${modelId}`;
const reference = { modelId, commandId: 'original-command', operation: 'revoke' };
const unavailable = { status: 'not_available_yet' };
const time = '2026-10-14T09:00:00Z';
const access = { modelId, expectedSequence: 5, loadedAt: time, canManage: true,
  grants: [], grantTotal: 0, explanations: { configuredUses: unavailable },
  availability: { registrySupported: true, selectedConnection: unavailable,
    enabledModel: unavailable, connection: unavailable, key: unavailable, verification: unavailable },
  projection: { content: 'current', sequence: 5 } };
const status = { status: 'appended', modelId, commandId: reference.commandId,
  operation: 'grant.revoked', sequence: 5, changeId: 'change-one', currentSequence: 5,
  projection: { content: 'current', iam: 'current' } };
type Handler = (url: string, options?: RequestInit) => Response | Promise<Response>;
let fixture: ComponentFixture<ModelAccessEditor>;

function reply(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), { status: code });
}
function page(ids: string[], next: string | null): Response {
  function row(id: string) { return { id, displayName: `Candidate ${id}` }; }
  const rows = ids.map(row);
  return reply({ rows, next, loadedAt: time, projection: access.projection });
}
function held() {
  let release!: (response: Response) => void;
  function capture(resolve: (response: Response) => void) { release = resolve; }
  const promise = new Promise<Response>(capture);
  return { promise, release };
}
async function mount(handler: Handler): Promise<ModelAccessEditor> {
  function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    return Promise.resolve(handler(String(input), options));
  }
  vi.stubGlobal('fetch', fetchReply);
  TestBed.configureTestingModule({ imports: [ModelAccessEditor] });
  fixture = TestBed.createComponent(ModelAccessEditor);
  fixture.detectChanges();
  await fixture.componentInstance.open(modelId, document.createElement('button'));
  fixture.detectChanges();
  return fixture.componentInstance;
}
function button(name: string): HTMLButtonElement | undefined {
  const root: HTMLElement = fixture.nativeElement as HTMLElement;
  for (const candidate of root.querySelectorAll('button')) {
    if (candidate.textContent?.trim() === name) return candidate;
  }
  return undefined;
}
async function more(): Promise<void> {
  fixture.detectChanges();
  const target = button('Load more');
  expect(target).toBeDefined();
  target?.click();
  await fixture.whenStable();
  fixture.detectChanges();
}
function store(): void { sessionStorage.setItem(key, JSON.stringify(reference)); }
function rows(editor: ModelAccessEditor): string[] {
  function id(row: { id: string }) { return row.id; }
  return editor['candidates']()?.rows.map(id) ?? [];
}
function cleanUp(): void {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
}
afterEach(cleanUp);

it('pages with the same kind and cursor, deduplicates, retries and prevents double reads', async () => {
  const requests: string[] = [];
  const pending = held();
  let failed = true;
  function serve(url: string) {
    if (url === base) return reply(access);
    requests.push(url);
    if (!url.includes('after=')) return page(['one'], 'cursor');
    if (failed) return reply({}, 503);
    return pending.promise;
  }
  const editor = await mount(serve);
  await editor['add']('team');
  await more();
  expect(rows(editor)).toEqual(['one']);
  failed = false;
  const loading = more();
  fixture.detectChanges();
  expect(button('Load more')?.disabled).toBe(true);
  button('Load more')?.click();
  pending.release(page(['one', 'two', 'two'], null));
  await loading;
  expect(requests).toEqual([`${base}/candidates?kind=team&limit=50`,
    `${base}/candidates?kind=team&after=cursor&limit=50`,
    `${base}/candidates?kind=team&after=cursor&limit=50`]);
  expect(rows(editor)).toEqual(['one', 'two']);
  expect(button('Load more')).toBeUndefined();
});

it('resets paging on a kind switch and ignores successful replies after switch or close', async () => {
  const pending = held();
  const requests: string[] = [];
  function serve(url: string) {
    if (url === base) return reply(access);
    requests.push(url);
    if (url.includes('after=')) return pending.promise;
    return page(['first'], 'cursor');
  }
  const editor = await mount(serve);
  await editor['add']('member');
  const loading = more();
  await editor['add']('team');
  pending.release(page(['late'], null));
  await loading;
  expect(rows(editor)).toEqual(['first']);
  expect(requests.at(-1)).toBe(`${base}/candidates?kind=team&limit=50`);
  editor.close();
  await editor.open(modelId, document.createElement('button'));
  await editor['add']('team');
  const closing = more();
  editor.close();
  await closing;
  expect(rows(editor)).toEqual([]);
});

it.each(['grant', 'revoke'] as const)('stores only the %s reference before POST and recovers without POST',
  async operation => {
    const pending = held();
    const posts: string[] = [];
    const reads: string[] = [];
    let stored: unknown;
    let commandId = '';
    function serve(url: string, options?: RequestInit) {
      if (options?.method === 'POST') {
        stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        commandId = (stored as typeof reference | null)?.commandId ?? '';
        posts.push(String(options.body));
        return pending.promise;
      }
      if (url.includes('/changes/')) {
        reads.push(url);
        const receiptOperation = operation === 'grant' ? 'grant.given' : 'grant.revoked';
        return reply({ ...status, commandId, operation: receiptOperation });
      }
      return reply(access);
    }
    const editor = await mount(serve);
    editor['choose'](operation, 'team', 'private-grantee');
    const saving = editor['save']();
    await editor['save']();
    expect(stored).toEqual({ modelId, commandId: expect.any(String), operation });
    fixture.destroy();
    const restored = await mount(serve);
    expect(restored['phase']()).toBe('saved');
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(posts).toHaveLength(1);
    expect(reads).toEqual([`${base}/changes/${commandId}`]);
    pending.release(reply({}, 503));
    await saving;
  });

it.each([404, 503, 0, 'applying', 'commandId', 'modelId', 'operation', 'content', 'list'])(
  'keeps reload recovery read-only for %s', async outcome => {
    store();
    const requests: string[] = [];
    const methods: string[] = [];
    let lists = 0;
    function serve(url: string, options?: RequestInit): Response {
      methods.push(options?.method ?? 'GET');
      if (!url.includes('/changes/')) {
        lists += 1;
        if (outcome === 'list' && lists > 1) return reply({}, 503);
        return reply(access);
      }
      requests.push(url);
      if (outcome === 0) throw new Error('Offline');
      if (typeof outcome === 'number') return reply({ status: 'unavailable' }, outcome);
      if (outcome === 'applying') {
        return reply({ ...status, projection: { content: 'current', iam: 'applying' } });
      }
      if (outcome === 'content') {
        return reply({ ...status, projection: { content: 'applying', iam: 'current' } });
      }
      if (outcome === 'list') return reply(status);
      const other = outcome === 'operation' ? 'grant.given' : 'another';
      return reply({ ...status, [outcome]: other });
    }
    const editor = await mount(serve);
    const applying = outcome === 'applying' || outcome === 'content' || outcome === 'list';
    expect(editor['phase']()).toBe(applying ? 'applying' : 'unknown');
    expect(requests).toHaveLength(applying && outcome !== 'list' ? 3 : 1);
    expect(new Set(requests)).toEqual(new Set([`${base}/changes/${reference.commandId}`]));
    expect(button('Check status')).toBeDefined();
    expect(button('Try again')).toBeUndefined();
    expect(button('Save access')).toBeUndefined();
    await editor['send']();
    await editor['check']();
    expect(methods).not.toContain('POST');
    expect(sessionStorage.getItem(key)).not.toBeNull();
  });

it.each([401, 403])('clears every stored reference on %s from any read or parent denial', async code => {
  for (const read of ['', '/candidates', '/changes/', 'parent']) {
    function serve(url: string) {
      if (read !== 'parent' && url.includes(`${base}${read}`)) return reply({}, code);
      return reply(access);
    }
    store();
    sessionStorage.setItem('model-access:another', JSON.stringify({ ...reference, modelId: 'another' }));
    if (read === '/candidates') sessionStorage.removeItem(key);
    const editor = await mount(serve);
    if (read === '/candidates') await editor['add']('member');
    if (read === 'parent') {
      fixture.componentRef.setInput('denied', true);
      fixture.detectChanges();
    }
    expect(sessionStorage.length).toBe(0);
    expect(editor['phase']()).toBe('access');
    fixture.destroy();
  }
});

it.each(['broken', JSON.stringify({ ...reference, body: {} }),
  JSON.stringify({ ...reference, modelId: 'another' })])('drops an invalid stored entry: %s', async value => {
  sessionStorage.setItem(key, value);
  function serve() { return reply(access); }
  const editor = await mount(serve);
  expect(editor['phase']()).toBe('ready');
  expect(sessionStorage.getItem(key)).toBeNull();
});

it.each([409, 200, 503])('removes a reference on a proved POST outcome %s', async code => {
  const stored: (string | null)[] = [];
  function serve(_url: string, options?: RequestInit) {
    if (options?.method !== 'POST') return reply(access);
    stored.push(sessionStorage.getItem(key));
    const outcome = code === 200 ? 'no_effect' : 'unavailable';
    return reply({ status: outcome }, code);
  }
  const editor = await mount(serve);
  editor['choose']('revoke', 'team', 'one');
  await editor['save']();
  expect(sessionStorage.getItem(key)).toBeNull();
  if (code === 503) await editor['send']();
  expect(stored).toHaveLength(code === 503 ? 2 : 1);
  expect(stored).not.toContain(null);
});

it('continues safely when storage throws', async () => {
  function blocked(): never { throw new Error('Storage blocked'); }
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
  function serve(_url: string, options?: RequestInit) {
    if (options?.method === 'POST') return reply({ status: 'no_effect' });
    return reply(access);
  }
  const editor = await mount(serve);
  editor['choose']('revoke', 'team', 'one');
  await editor['save']();
  expect(editor['phase']()).toBe('no_effect');
});
