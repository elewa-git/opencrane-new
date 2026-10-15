import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';
import { isObject } from './memory-panel-data';

const privateText = 'A private fact that must disappear.';
const savedFact = { memoryId: 'fact-one', revision: 3, text: privateText,
  kind: 'fact', pinned: false, expiresAt: null, savedAt: '2026-10-02T10:00:00Z' };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function scope(scopeKind: 'person' | 'group' | 'assistant_notes') {
  return { scopeId: 'scope', scopeKind, ownerId: 'member', canRead: true,
    audience: { kind: scopeKind, ownerId: 'member' } };
}

function receipt(cleanupStatus: string) {
  return { operation: 'forget', outcome: 'accepted', hidden: true, cleanupStatus,
    memoryId: 'fact-one', scopeId: 'scope', revision: 4, forgottenAt: '2026-10-04T09:20:00Z' };
}

function text(fixture: ComponentFixture<MemoryPanel>): string {
  return pageElement(fixture).textContent ?? '';
}

function pageElement(fixture: ComponentFixture<MemoryPanel>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing memory panel');
  return element;
}

function button(fixture: ComponentFixture<MemoryPanel>, name: string): HTMLButtonElement {
  const buttons = pageElement(fixture).querySelectorAll<HTMLButtonElement>('button');
  const found = Array.from(buttons).find(buttonMatches.bind(null, name));
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

function buttonMatches(name: string, candidate: HTMLButtonElement): boolean {
  return candidate.textContent?.trim() === name;
}

function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeModal(this: HTMLDialogElement): void { this.removeAttribute('open'); }

async function openDetail(kind: 'person' | 'group' | 'assistant_notes' = 'person',
  detail: unknown = { scopeId: 'scope', fact: savedFact, sources: [], canForget: true },
  postReply: Response | Promise<Response> = reply(200, receipt('pending')),
  statusReply: Response = reply(200, receipt('forgotten')),
): Promise<{ fixture: ComponentFixture<MemoryPanel>; posts: string[];
  detailGets: () => number }> {
  const posts: string[] = [];
  let detailReads = 0;
  async function fetchReply(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input);
    if (url.endsWith('/scopes')) return reply(200, { scopes: [scope(kind)] });
    if (url.includes('/facts?')) return reply(200, { scopeId: 'scope', facts: [savedFact],
      returnedCount: 1, nextCursor: null });
    if (url.endsWith('/forget')) {
      posts.push(typeof init?.body === 'string' ? init.body : '');
      return postReply;
    }
    if (url.endsWith('/facts/fact-one')) {
      detailReads += 1;
      return reply(200, detail);
    }
    if (url.includes('/changes/')) return statusReply;
    throw new Error('Unexpected request');
  }
  vi.stubGlobal('fetch', vi.fn(fetchReply));
  TestBed.configureTestingModule({ imports: [MemoryPanel] });
  const fixture = TestBed.createComponent(MemoryPanel);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain(privateText);
  });
  const factButton = pageElement(fixture).querySelector<HTMLButtonElement>('button.fact');
  if (!factButton) throw new Error('Missing fact row');
  factButton.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toMatch(/Revision|no longer available/);
  });
  function detailGets(): number { return detailReads; }
  return { fixture, posts, detailGets };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

Object.assign(HTMLDialogElement.prototype, { showModal, close: closeModal });

it.each(['group', 'assistant_notes'] as const)('hides Forget in %s detail', async kind => {
  const { fixture } = await openDetail(kind);
  expect(() => button(fixture, 'Forget')).toThrow();
});

it('hides Forget when detail is unavailable', async () => {
  const detail = { status: 'unavailable', scopeId: 'scope', memoryId: 'fact-one',
    revision: 4, reason: 'forgotten' };
  const { fixture } = await openDetail('person', detail);
  expect(() => button(fixture, 'Forget')).toThrow();
});

it('reviews without fact text and Cancel sends no command', async () => {
  const { fixture, posts } = await openDetail();
  const opener = button(fixture, 'Forget');
  const visibleRects = opener.getClientRects();
  Object.defineProperty(visibleRects, 'length', { value: 1 });
  vi.spyOn(opener, 'getClientRects').mockReturnValue(visibleRects);
  opener.click();
  fixture.detectChanges();
  const sheet = pageElement(fixture).querySelector<HTMLElement>('oc-modal-sheet');
  if (!sheet) throw new Error('Missing review sheet');
  expect(sheet.textContent).toContain('Forget this fact from your memory?');
  expect(sheet.textContent).toContain('Only you lose it from memory.');
  expect(sheet.textContent).not.toContain(privateText);
  button(fixture, 'Cancel').click();
  fixture.detectChanges();
  expect(posts).toHaveLength(0);
  expect(document.activeElement?.textContent?.trim()).toBe('Forget');
});

it('posts once and removes all fact text on a pending receipt', async () => {
  const { fixture, posts } = await openDetail();
  const addressBefore = location.href;
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Hidden · cleanup pending');
  });
  expect(posts).toHaveLength(1);
  const payload: unknown = JSON.parse(posts[0] ?? '');
  if (!isObject(payload)) throw new Error('Missing forget command');
  expect(payload['expectedRevision']).toBe(3);
  expect(payload['commandId']).toMatch(/^mem_[\da-f-]+$/);
  expect(text(fixture)).not.toContain(privateText);
  const liveRegion = pageElement(fixture).querySelector('[aria-live]');
  expect(liveRegion?.textContent).not.toContain(privateText);
  expect(location.href).toBe(addressBefore);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('shows conflict and offers a detail read without another POST', async () => {
  const { fixture, posts, detailGets } = await openDetail('person', undefined,
    reply(409, { outcome: 'conflict' }));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Changed before you forgot it');
  });
  expect(posts).toHaveLength(1);
  button(fixture, 'Review latest revision').click();
  await vi.waitFor(() => expect(detailGets()).toBe(2));
  expect(posts).toHaveLength(1);
});

it('keeps a 503 outcome unknown and checks the same command only', async () => {
  const { fixture, posts } = await openDetail('person', undefined,
    reply(503, { status: 'unavailable' }));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Outcome unknown');
  });
  button(fixture, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Forgotten');
  });
  expect(posts).toHaveLength(1);
  expect(text(fixture)).not.toContain(privateText);
});

it.each([
  { outcome: 'unknown', message: 'Outcome unknown' },
  { outcome: 'conflict', message: 'Changed before you forgot it' },
])('handles a $outcome status without another POST', async status => {
  const statusReply = reply(200, { outcome: status.outcome });
  const { fixture, posts } = await openDetail('person', undefined,
    reply(503, { status: 'unavailable' }), statusReply);
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Outcome unknown');
  });
  button(fixture, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain(status.message);
  });
  expect(posts).toHaveLength(1);
});

it('keeps an accepted fact hidden when cleanup is unavailable', async () => {
  const { fixture } = await openDetail('person', undefined,
    reply(200, receipt('unavailable')));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Cleanup unavailable');
  });
  expect(text(fixture)).toContain('Stays hidden — it won’t reappear');
  expect(text(fixture)).not.toContain(privateText);
});

it('ignores a late accepted reply after access is revoked', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>(resolve => { finishPost = resolve; });
  const { fixture } = await openDetail('person', undefined, pending);
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  fixture.componentRef.setInput('accessDenied', true);
  fixture.detectChanges();
  finishPost?.(reply(200, receipt('pending')));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(text(fixture)).toContain('Access changed');
  expect(text(fixture)).not.toContain('Hidden · cleanup pending');
  expect(text(fixture)).not.toContain(privateText);
});

it('ignores a late reply after the requester changes', async () => {
  let finishPost: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>(resolve => { finishPost = resolve; });
  const { fixture } = await openDetail('person', undefined, pending);
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  fixture.componentRef.setInput('requesterId', 'another-requester');
  fixture.detectChanges();
  finishPost?.(reply(200, receipt('pending')));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(text(fixture)).not.toContain('Hidden · cleanup pending');
});

it.each([401, 403, 404])('clears memory when forget returns %s', async status => {
  const { fixture } = await openDetail('person', undefined,
    reply(status, { status: 'refused' }));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Access changed');
  });
  expect(text(fixture)).not.toContain(privateText);
});
