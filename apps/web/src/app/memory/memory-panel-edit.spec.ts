import { By } from '@angular/platform-browser';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryEdit } from './memory-edit';
import { isObject, type Fact } from './memory-panel-data';
import { MemoryPanel } from './memory-panel';

const fact: Fact = { memoryId: 'one', revision: 7, text: 'Private original text', kind: 'preference',
  pinned: true, expiresAt: '2027-01-01T00:00:00Z', savedAt: '2026-10-02T10:00:00Z' };
const updated = { ...fact, revision: 8, text: 'New private text' };
const detail = { scopeId: 'scope', fact, sources: [], canForget: true, canCorrect: true };
const accepted = { operation: 'correct', outcome: 'accepted', scopeId: 'scope', memoryId: 'one',
  revision: 8, acceptedAt: '2026-10-20T10:00:00Z', contentStatus: 'current', cleanupStatus: 'pending' };
function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
function deferred() {
  let resolve!: (value: Response) => void;
  function rememberResolver(finish: (value: Response) => void): void { resolve = finish; }
  const promise = new Promise<Response>(rememberResolver);
  return { promise, resolve };
}
function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeModal(this: HTMLDialogElement): void { this.removeAttribute('open'); }
Object.assign(HTMLDialogElement.prototype, { showModal, close: closeModal });
let fixture: ComponentFixture<MemoryPanel>;
let root: HTMLElement;
let calls: { url: string; init?: RequestInit | undefined }[];
let post: () => Promise<Response>;
let status: () => Promise<Response>;
let latest: () => Promise<Response>;
function buttons(name: string): HTMLButtonElement[] {
  const matches: HTMLButtonElement[] = [];
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    if (button.textContent?.trim() === name) matches.push(button);
  }
  return matches;
}
function click(name: string): void {
  const button = buttons(name).at(-1);
  if (!button) throw new Error(`Missing ${name}`);
  button.click();
  fixture.detectChanges();
}
function input(value: string): void {
  const field = root.querySelector('textarea');
  if (!field) throw new Error('Missing draft');
  field.value = value;
  field.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}
function saveDraft(): void {
  click('Edit');
  input('My draft');
  click('Save correction');
}
function hasSettled(): void {
  fixture.detectChanges();
  expect(root.textContent).not.toMatch(/Checking memory…|Loading memory…|Searching memory…/);
}
async function settled(): Promise<void> {
  await vi.waitFor(hasSettled);
}
async function setup(kind = 'person', body: unknown = detail): Promise<void> {
  calls = [];
  post = () => Promise.resolve(response(200, accepted));
  status = () => Promise.resolve(response(200, accepted));
  latest = () => Promise.resolve(response(200, { ...detail, fact: updated }));
  let reads = 0;
  async function fetchReply(url: string, init?: RequestInit): Promise<Response> {
    calls.push({ url, init });
    if (url.endsWith('/scopes')) return response(200, { scopes: [
      { scopeId: 'scope', scopeKind: kind, ownerId: 'me', canRead: true,
        audience: { kind, ownerId: 'me' } },
      { scopeId: 'other', scopeKind: 'person', ownerId: 'me', canRead: true,
        audience: { kind: 'person', ownerId: 'me' } },
    ] });
    if (url.includes('/facts?')) return response(200, { facts: [{ ...fact, revision: 3, kind: 'fact', pinned: false, expiresAt: null }],
      returnedCount: 1,
      nextCursor: null });
    if (url.endsWith('/correct')) return post();
    if (url.includes('/changes/')) return status();
    reads += 1;
    if (reads > 1) return latest();
    return response(200, body);
  }
  vi.stubGlobal('fetch', vi.fn(fetchReply));
  TestBed.configureTestingModule({ imports: [MemoryPanel] });
  fixture = TestBed.createComponent(MemoryPanel);
  fixture.componentRef.setInput('requesterId', 'first');
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing panel');
  root = element;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.querySelector('button.fact')).not.toBeNull();
  });
  root.querySelector<HTMLButtonElement>('button.fact')?.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(root.textContent).toMatch(/Revision|no longer available/);
  });
}
function matching(suffix: string) { return calls.filter(matchesSuffix.bind(null, suffix)); }
function matchesSuffix(suffix: string, call: { url: string }): boolean {
  return call.url.endsWith(suffix);
}
function noPrivateAnnouncements(): void {
  for (const region of root.querySelectorAll('[aria-live], [role="status"], [role="alert"]')) {
    expect(region.textContent).not.toMatch(/Private original text|New private text|My draft/);
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); TestBed.resetTestingModule(); });

it.each([
  ['person', { ...detail, canCorrect: false }], ['person', { ...detail, canCorrect: undefined }],
  ['group', detail], ['assistant_notes', detail],
  ['person', { status: 'unavailable', reason: 'forgotten' }],
])('hides Edit for %s without current personal rights', async (kind, body) => {
  await setup(String(kind), body);
  expect(buttons('Edit')).toHaveLength(0);
});

it('validates bytes and controls; Cancel and Escape send nothing and refocus Edit', async () => {
  await setup();
  const opener = buttons('Edit')[0];
  if (!opener) throw new Error('Missing Edit');
  const rects = opener.getClientRects();
  Object.defineProperty(rects, 'length', { value: 1 });
  vi.spyOn(opener, 'getClientRects').mockReturnValue(rects);
  click('Edit');
  expect(root.textContent).toContain('Current revision r7');
  expect(root.textContent).toContain('Replaces r7 in your memory');
  for (const invalid of ['é'.repeat(2048) + 'x', 'bad\u0001']) {
    input(invalid);
    expect(buttons('Save correction')[0]?.disabled).toBe(true);
  }
  input('é'.repeat(2048));
  expect(buttons('Save correction')[0]?.disabled).toBe(false);
  const count = calls.length;
  click('Cancel');
  expect(document.activeElement).toBe(opener);
  click('Edit');
  root.querySelector('oc-memory-edit dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }));
  fixture.detectChanges();
  expect(document.activeElement).toBe(opener);
  expect(calls).toHaveLength(count);
});

it('sends one immutable command, locks dismissal, and refreshes once after acceptance', async () => {
  await setup();
  const pending = deferred();
  post = () => pending.promise;
  const address = location.href;
  click('Edit');
  input('My draft');
  const save = buttons('Save correction')[0];
  save?.click();
  save?.click();
  fixture.detectChanges();
  const sheet = root.querySelector<HTMLDialogElement>('oc-memory-edit dialog');
  sheet?.dispatchEvent(new Event('cancel', { cancelable: true }));
  sheet?.click();
  fixture.detectChanges();
  expect(sheet?.open).toBe(true);
  expect(matching('/correct')).toHaveLength(1);
  const payload: unknown = JSON.parse(postBody(0));
  expect(commandId()).toMatch(/^mem_[\da-f-]+$/);
  expect(payload).toMatchObject({
    expectedRevision: 7, text: 'My draft', kind: fact.kind, pinned: true, expiresAt: fact.expiresAt });
  pending.resolve(response(200, accepted));
  await settled();
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(matching('/facts/one')).toHaveLength(2);
  expect(root.querySelector('.results')?.textContent).toContain(updated.text);
  expect(root.querySelector('button.fact')?.textContent).toContain('r8');
  expect(root.querySelector('.detail-text')?.textContent).toBe(updated.text);
  expect(root.querySelector('.fact-context')?.textContent).toContain('8');
  expect(root.querySelector('.edit-receipt')?.textContent).not.toContain('My draft');
  const editor: unknown = fixture.debugElement.query(By.directive(MemoryEdit))?.componentInstance;
  if (!(editor instanceof MemoryEdit)) throw new Error('Missing editor');
  await editor['applyBody']({ outcome: 'unknown' });
  await editor['applyBody']({ outcome: 'conflict' });
  fixture.detectChanges();
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(root.querySelector('oc-memory-edit dialog[open]')).toBeNull();
  noPrivateAnnouncements();
  expect(location.href).toBe(address);
  expect(localStorage.length + sessionStorage.length).toBe(0);
});

it.each(['post', 'status'])('reviews a %s conflict and saves a new command', async source => {
  await setup();
  post = () => Promise.resolve(response(source === 'post' ? 409 : 503, {}));
  status = () => Promise.resolve(response(200, { outcome: 'conflict' }));
  saveDraft();
  await settled();
  if (source === 'status') { click('Check status'); await settled(); }
  expect(root.textContent).toContain('This fact changed before your edit was saved');
  expect(matching('/correct')).toHaveLength(1);
  click('Refresh and review');
  await settled();
  expect(matching('/facts/one')).toHaveLength(2);
  expect(root.querySelector('textarea')?.value).toBe('My draft');
  expect(root.textContent).toContain('Current revision r8');
  expect(matching('/correct')).toHaveLength(1);
  click('Save correction');
  await settled();
  expect(matching('/correct')).toHaveLength(2);
  expect(commandId(1)).not.toBe(commandId());
  expect(postBody(1)).toContain('"expectedRevision":8');
});

it.each(['lost', '503', 'unknown'])('recovers %s only with serial status reads of the same command', async failure => {
  await setup();
  post = () => {
    if (failure === 'lost') return Promise.reject(new Error('Lost'));
    return Promise.resolve(response(failure === '503' ? 503 : 200, { outcome: 'unknown' }));
  };
  click('Edit');
  click('Save correction');
  await settled();
  expect(root.textContent).toContain('Outcome unknown');
  expect(buttons('Save correction')).toHaveLength(0);
  expect(buttons('Cancel')).toHaveLength(0);
  const pending = deferred();
  status = () => pending.promise;
  const check = buttons('Check status')[0];
  check?.click();
  check?.click();
  fixture.detectChanges();
  expect(calls.filter(isStatus)).toHaveLength(1);
  expect(calls.find(isStatus)?.url).toBe(`/api/memory/scope/changes/${commandId()}`);
  pending.resolve(response(200, accepted));
  await settled();
  check?.click();
  await settled();
  expect(calls.filter(isStatus)).toHaveLength(1);
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(matching('/correct')).toHaveLength(1);
});
function isStatus(call: { url: string }): boolean { return call.url.includes('/changes/'); }
function postBody(index: number): string {
  const body = matching('/correct')[index]?.init?.body;
  if (typeof body !== 'string') throw new Error('Missing body');
  return body;
}
function commandId(index = 0): string {
  const body: unknown = JSON.parse(postBody(index));
  if (!isObject(body) || typeof body['commandId'] !== 'string') throw new Error('Missing command');
  return body['commandId'];
}

it.each([401, 403, 404, 'forgotten'] as const)('clears all protected text after %s', async outcome => {
  await setup();
  post = () => Promise.resolve(response(outcome === 'forgotten' ? 409 : outcome, {}));
  latest = () => Promise.resolve(response(200, { status: 'unavailable', reason: 'forgotten' }));
  saveDraft();
  await settled();
  if (outcome === 'forgotten') { click('Refresh and review'); await settled(); }
  expect(root.textContent).not.toMatch(/Private original text|My draft/);
  for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    expect(field.value).not.toMatch(/Private original text|My draft/);
  }
  noPrivateAnnouncements();
});

it('returns a rejected validation to editing', async () => {
  await setup();
  post = () => Promise.resolve(response(422, {}));
  saveDraft();
  await settled();
  expect(root.textContent).toContain('Nothing was saved');
  expect(root.querySelector('textarea')?.value).toBe('My draft');
  expect(buttons('Save correction')[0]?.disabled).toBe(false);
});

it.each(['requester', 'scope'])('ignores late replies after %s changes', async change => {
  await setup();
  const pending = deferred();
  post = () => pending.promise;
  saveDraft();
  if (change === 'requester') fixture.componentRef.setInput('requesterId', 'second');
  else void fixture.componentInstance['chooseScope']('other');
  fixture.detectChanges();
  pending.resolve(response(200, accepted));
  await settled();
  expect(root.textContent).not.toContain('Corrected in your memory');
  expect(root.textContent).not.toContain('My draft');
  expect(matching('/facts/one')).toHaveLength(1);
});

it('resizes the phone sheet when the keyboard reduces the visible height', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844 });
  vi.stubGlobal('visualViewport', viewport);
  await setup();
  click('Edit');
  viewport.height = 420;
  viewport.dispatchEvent(new Event('resize'));
  fixture.detectChanges();
  const editor = root.querySelector<HTMLElement>('oc-memory-edit');
  expect(editor?.style.getPropertyValue('--oc-sheet-height')).toBe('420px');
});

it.each([
  ['quarantined', 'conflict'], ['quarantined', 'accepted'],
  ['destroyed', 'conflict'], ['destroyed', 'accepted'],
  ['forgotten', 'conflict'], ['forgotten', 'accepted'],
])(
  'keeps the %s reason after %s', async (reason, outcome) => {
    await setup();
    const unavailable = { status: 'unavailable', reason };
    post = () => Promise.resolve(response(outcome === 'conflict' ? 409 : 200, accepted));
    latest = () => Promise.resolve(response(200, unavailable));
    saveDraft();
    await settled();
    if (outcome === 'conflict') {
      click('Refresh and review');
      await settled();
    }
    const sheet = root.querySelector('oc-memory-edit');
    if (reason === 'forgotten') {
      expect(sheet?.textContent).toContain('This fact was forgotten. Your edit wasn’t applied.');
      expect(root.querySelector('button.fact')).toBeNull();
    } else {
      expect(sheet?.textContent).toContain(
        'This fact’s text is no longer available. Your edit wasn’t applied.');
      expect(sheet?.textContent).not.toContain('forgotten');
      expect(root.querySelector('button.fact')?.textContent).toContain(fact.text);
    }
    expect(sheet?.querySelector('textarea')).toBeNull();
    expect(sheet?.querySelector('.preview')).toBeNull();
    expect(sheet?.textContent).not.toContain('My draft');
    noPrivateAnnouncements();
  });

function editorComponent(): MemoryEdit {
  const editor: unknown = fixture.debugElement.query(By.directive(MemoryEdit))?.componentInstance;
  if (!(editor instanceof MemoryEdit)) throw new Error('Missing editor');
  return editor;
}
function acceptanceStarted(): void {
  fixture.detectChanges();
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(matching('/facts/one')).toHaveLength(2);
}
function replyTurn(finish: () => void): void { setTimeout(finish, 0); }
async function finishReplies(): Promise<void> {
  await new Promise<void>(replyTurn);
  fixture.detectChanges();
}

it('keeps Edit disabled until the accepted detail resolves and saves the displayed revision', async () => {
  await setup();
  const pending = deferred();
  latest = () => pending.promise;
  saveDraft();
  await vi.waitFor(acceptanceStarted);
  expect(buttons('Edit')[0]?.disabled).toBe(true);
  const editor = fixture.debugElement.query(By.directive(MemoryEdit));
  editor.query(By.css('.edit-open')).triggerEventHandler('click', new Event('click'));
  fixture.detectChanges();
  expect(root.querySelector('oc-memory-edit textarea')).toBeNull();
  const nextFact = { ...updated, savedAt: '2026-10-21T11:30:00Z' };
  const nextDetail = { ...detail, fact: nextFact };
  pending.resolve(response(200, nextDetail));
  await finishReplies();
  expect(buttons('Edit')[0]?.disabled).toBe(false);
  click('Edit');
  expect(root.textContent).toContain('Current revision r8 · 21 Oct 2026, 11:30 UTC');
  expect(root.textContent).toContain('Replaces r8 in your memory');
  input('Second correction');
  click('Save correction');
  await settled();
  expect(postBody(1)).toContain('"expectedRevision":8');
});

it('keeps both revision labels and the saved date on the command snapshot', async () => {
  await setup();
  click('Edit');
  const newerFact = { ...updated, savedAt: '2026-10-21T11:30:00Z' };
  fixture.componentInstance['selectedFact'].set(newerFact);
  fixture.detectChanges();
  expect(root.textContent).toContain('Current revision r7 · 2 Oct 2026, 10:00 UTC');
  expect(root.textContent).toContain('Replaces r7 in your memory');
  click('Save correction');
  await settled();
  expect(postBody(0)).toContain('"expectedRevision":7');
});

it.each([false, undefined])('refuses renewed editing when canCorrect is %s', async canCorrect => {
  await setup();
  post = () => Promise.resolve(response(409, {}));
  const readOnlyDetail = { ...detail, fact: updated, canCorrect };
  latest = () => Promise.resolve(response(200, readOnlyDetail));
  saveDraft();
  await settled();
  click('Refresh and review');
  await settled();
  expect(root.textContent).toContain('This fact changed before your edit was saved');
  expect(root.querySelector('oc-memory-edit textarea')).toBeNull();
  expect(buttons('Save correction')).toHaveLength(0);
  expect(buttons('Edit')).toHaveLength(0);
  expect(matching('/correct')).toHaveLength(1);
});

it.each(['memoryId', 'scopeId'])('rejects a receipt for another %s', async field => {
  await setup();
  const unrelated = { ...accepted, [field]: 'another' };
  post = () => Promise.resolve(response(200, unrelated));
  saveDraft();
  await settled();
  expect(root.textContent).toContain('Outcome unknown');
  expect(root.textContent).not.toContain('Corrected in your memory');
  expect(root.querySelector('.edit-receipt')).toBeNull();
  expect(matching('/facts/one')).toHaveLength(1);
});

function changeIdentity(change: string): void {
  if (change === 'requester') fixture.componentRef.setInput('requesterId', 'second');
  else void fixture.componentInstance['chooseScope']('other');
  fixture.detectChanges();
}
function noEditorText(): void {
  expect(root.textContent).not.toMatch(/Corrected in your memory|My draft|New private text/);
  expect(root.querySelector('textarea')).toBeNull();
  noPrivateAnnouncements();
}

it.each(['scope', 'requester'])('ignores a late refused POST after a %s change', async change => {
  await setup();
  const pending = deferred();
  post = () => pending.promise;
  const editor = editorComponent();
  const accessLost = vi.spyOn(editor.accessLost, 'emit');
  const refreshed = vi.spyOn(editor.refreshed, 'emit');
  saveDraft();
  changeIdentity(change);
  await finishReplies();
  const count = calls.length;
  pending.resolve(response(403, {}));
  await finishReplies();
  expect(accessLost).not.toHaveBeenCalled();
  expect(refreshed).not.toHaveBeenCalled();
  expect(calls).toHaveLength(count);
  noEditorText();
});

it.each(['scope', 'requester'])('ignores a late POST body after a %s change', async change => {
  await setup();
  const pending = deferred();
  const delayed = response(200, accepted);
  async function readBody(): Promise<unknown> {
    const reply = await pending.promise;
    return reply.json();
  }
  const read = vi.spyOn(delayed, 'json').mockImplementation(readBody);
  post = () => Promise.resolve(delayed);
  const editor = editorComponent();
  const accessLost = vi.spyOn(editor.accessLost, 'emit');
  const refreshed = vi.spyOn(editor.refreshed, 'emit');
  saveDraft();
  function bodyStarted(): void { expect(read).toHaveBeenCalledOnce(); }
  await vi.waitFor(bodyStarted);
  changeIdentity(change);
  await finishReplies();
  const count = calls.length;
  pending.resolve(response(200, accepted));
  await finishReplies();
  expect(accessLost).not.toHaveBeenCalled();
  expect(refreshed).not.toHaveBeenCalled();
  expect(calls).toHaveLength(count);
  noEditorText();
});

it.each(['scope', 'requester'])('ignores a late detail after a %s change', async change => {
  await setup();
  const pending = deferred();
  latest = () => pending.promise;
  const editor = editorComponent();
  const accessLost = vi.spyOn(editor.accessLost, 'emit');
  const refreshed = vi.spyOn(editor.refreshed, 'emit');
  saveDraft();
  await vi.waitFor(acceptanceStarted);
  changeIdentity(change);
  await finishReplies();
  const count = calls.length;
  const nextDetail = { ...detail, fact: updated };
  pending.resolve(response(200, nextDetail));
  await finishReplies();
  expect(accessLost).not.toHaveBeenCalled();
  expect(refreshed).not.toHaveBeenCalled();
  expect(calls).toHaveLength(count);
  noEditorText();
});
