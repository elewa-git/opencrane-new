import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';

const fact = { memoryId: 'one', revision: 7, text: 'Private original text', kind: 'preference',
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
async function settled(): Promise<void> {
  await fixture.whenStable();
  fixture.detectChanges();
}
async function setup(kind = 'person', body: unknown = detail): Promise<void> {
  calls = [];
  post = async () => response(200, accepted);
  status = async () => response(200, accepted);
  latest = async () => response(200, { ...detail, fact: updated });
  let reads = 0;
  async function fetchReply(url: string, init?: RequestInit): Promise<Response> {
    calls.push({ url, init });
    if (url.endsWith('/scopes')) return response(200, { scopes: [
      { scopeId: 'scope', scopeKind: kind, ownerId: 'me', canRead: true,
        audience: { kind, ownerId: 'me' } },
      { scopeId: 'other', scopeKind: 'person', ownerId: 'me', canRead: true,
        audience: { kind: 'person', ownerId: 'me' } },
    ] });
    if (url.includes('/facts?')) return response(200, { facts: [fact], returnedCount: 1,
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
  await settled();
  root = fixture.nativeElement as HTMLElement;
  root.querySelector<HTMLButtonElement>('button.fact')?.click();
  await settled();
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
  vi.spyOn(opener, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
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
  const payload: unknown = JSON.parse(String(matching('/correct')[0]?.init?.body));
  expect(payload).toEqual({ commandId: expect.stringMatching(/^mem_[\da-f-]+$/),
    expectedRevision: 7, text: 'My draft', kind: fact.kind, pinned: true, expiresAt: fact.expiresAt });
  pending.resolve(response(200, accepted));
  await settled();
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(matching('/facts/one')).toHaveLength(2);
  expect(root.querySelector('.results')?.textContent).toContain(updated.text);
  expect(root.querySelector('.detail-text')?.textContent).toBe(updated.text);
  expect(root.querySelector('.fact-context')?.textContent).toContain('8');
  expect(root.querySelector('.edit-receipt')?.textContent).not.toContain('My draft');
  noPrivateAnnouncements();
  expect(location.href).toBe(address);
  expect(localStorage.length + sessionStorage.length).toBe(0);
});

it.each([409, 200])('reviews a %s conflict once and saves the retained draft as a new command', async code => {
  await setup();
  post = async () => response(code, { outcome: 'conflict' });
  click('Edit');
  input('My draft');
  click('Save correction');
  await settled();
  expect(root.textContent).toContain('This fact changed before your edit was saved');
  expect(matching('/correct')).toHaveLength(1);
  click('Refresh and review');
  await settled();
  expect(matching('/facts/one')).toHaveLength(2);
  expect(root.querySelector('textarea')?.value).toBe('My draft');
  expect(root.textContent).toContain('Current revision r8');
  click('Save correction');
  await settled();
  const first = matching('/correct')[0]?.init?.body;
  const second = matching('/correct')[1]?.init?.body;
  expect(second).not.toBe(first);
  expect(String(second)).toContain('"expectedRevision":8');
});

it.each(['lost', '503', 'unknown'])('recovers %s only with serial status reads of the same command', async failure => {
  await setup();
  post = async () => {
    if (failure === 'lost') throw new Error('Lost');
    return response(failure === '503' ? 503 : 200, { outcome: 'unknown' });
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
  expect(calls.find(isStatus)?.url).toContain(commandId());
  pending.resolve(response(200, accepted));
  await settled();
  check?.click();
  await settled();
  expect(calls.filter(isStatus)).toHaveLength(1);
  expect(root.textContent).toContain('Corrected in your memory · r8');
  expect(matching('/correct')).toHaveLength(1);
});
function isStatus(call: { url: string }): boolean { return call.url.includes('/changes/'); }
function commandId(): string {
  const body: unknown = JSON.parse(String(matching('/correct')[0]?.init?.body));
  return (body as { commandId: string }).commandId;
}

it.each([401, 403, 404, 'forgotten'] as const)('clears all protected text after %s', async outcome => {
  await setup();
  post = async () => response(outcome === 'forgotten' ? 409 : outcome, {});
  latest = async () => response(200, { status: 'unavailable', reason: 'forgotten' });
  click('Edit');
  input('My draft');
  click('Save correction');
  await settled();
  if (outcome === 'forgotten') { click('Refresh and review'); await settled(); }
  expect(root.textContent).not.toMatch(/Private original text|My draft/);
  for (const field of root.querySelectorAll('input, textarea')) {
    expect((field as HTMLInputElement).value).not.toMatch(/Private original text|My draft/);
  }
  noPrivateAnnouncements();
});

it('returns a rejected validation to editing', async () => {
  await setup();
  post = async () => response(422, {});
  click('Edit');
  input('My draft');
  click('Save correction');
  await settled();
  expect(root.textContent).toContain('Nothing was saved');
  expect(root.querySelector('textarea')?.value).toBe('My draft');
  expect(buttons('Save correction')[0]?.disabled).toBe(false);
});

it.each(['requester', 'scope'])('ignores late replies after %s changes', async change => {
  await setup();
  const pending = deferred();
  post = () => pending.promise;
  click('Edit');
  input('My draft');
  click('Save correction');
  if (change === 'requester') fixture.componentRef.setInput('requesterId', 'second');
  else void fixture.componentInstance['chooseScope']('other');
  fixture.detectChanges();
  pending.resolve(response(200, accepted));
  await settled();
  expect(root.textContent).not.toContain('Corrected in your memory');
  expect(root.textContent).not.toContain('My draft');
  expect(matching('/facts/one')).toHaveLength(1);
});
