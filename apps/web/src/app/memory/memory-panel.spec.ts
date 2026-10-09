import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';

function visibleText(fixture: { nativeElement: unknown }): string {
  const element = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) return '';
  return element.textContent ?? '';
}

afterEach(resetTestEnvironment);

function resetTestEnvironment(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'cache-control': 'no-store' } });
}

function personalScope() {
  return { scopeId: 'scope', scopeKind: 'person', ownerId: 'member',
    audience: { kind: 'person', ownerId: 'member' }, canRead: true };
}

function fact(text: string) {
  return { memoryId: 'fact-one', revision: 1, text, kind: 'fact', pinned: false,
    expiresAt: null, savedAt: '2026-10-02T10:00:00Z' };
}

function stubReplies(...replies: Response[]): void {
  let replyIndex = 0;
  function nextReply(): Promise<Response> {
    const reply = replies[replyIndex];
    replyIndex += 1;
    if (!reply) throw new Error('No reply was set for this memory read');
    return Promise.resolve(reply);
  }
  vi.stubGlobal('fetch', vi.fn(nextReply));
}

function createPanel(): ComponentFixture<MemoryPanel> {
  TestBed.configureTestingModule({ imports: [MemoryPanel] });
  return TestBed.createComponent(MemoryPanel);
}

async function loadPanel(): Promise<ComponentFixture<MemoryPanel>> {
  const fixture = createPanel();
  fixture.detectChanges();
  await vi.waitFor(checkMemoryLoaded.bind(null, fixture));
  return fixture;
}

function checkMemoryLoaded(fixture: ComponentFixture<MemoryPanel>): void {
  fixture.detectChanges();
  if (visibleText(fixture).includes('Loading memory')) {
    throw new Error('Memory scopes are still loading');
  }
}

it('shows loading while scopes are pending', () => {
  vi.stubGlobal('fetch', vi.fn(waitForReply));
  TestBed.configureTestingModule({ imports: [MemoryPanel] });
  const fixture = TestBed.createComponent(MemoryPanel);
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Loading memory');
});

function waitForReply(): Promise<Response> {
  return new Promise<Response>(leaveReplyPending);
}

function leaveReplyPending(
  _resolve: (response: Response | PromiseLike<Response>) => void,
  _reject: (reason?: unknown) => void,
): void {
}

it.each([401, 403])('clears the panel after access is refused with %s', async (status) => {
  stubReplies(response(status, { status: 'refused' }));
  const fixture = await loadPanel();
  expect(visibleText(fixture)).toContain('Access changed');
});

it('shows unavailable when the scopes read fails', async () => {
  stubReplies(response(503, { status: 'unavailable' }));
  const fixture = await loadPanel();
  expect(visibleText(fixture)).toContain('Memory is unavailable');
});

it('shows an empty state when the permitted scope has no saved facts', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }));
  const fixture = await loadPanel();
  expect(visibleText(fixture)).toContain('No facts have been saved');
});

it('shows no results for a successful empty search', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }));
  const fixture = await loadPanel();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing memory page');
  const search = element.querySelector<HTMLInputElement>('input[type="search"]');
  if (!search) throw new Error('Missing search field');
  search.value = 'unknown topic';
  search.dispatchEvent(new Event('input'));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('No matching facts');
});

it('keeps a readable fact visible when its source check is unavailable', async () => {
  const savedFact = fact('Keep the short project name.');
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1, nextCursor: null }),
    response(200, { scopeId: 'scope', fact: savedFact, sources: [{ status: 'unavailable' }] }));
  const fixture = await loadPanel();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing memory page');
  const factButton = element.querySelector<HTMLButtonElement>('.fact');
  if (!factButton) throw new Error('Missing fact button');
  factButton.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Keep the short project name.');
  expect(visibleText(fixture)).toContain('Source could not be checked');
});

it('clears the fact if its detail read is refused', async () => {
  const savedFact = fact('Private fact text.');
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1, nextCursor: null }),
    response(403, { status: 'refused' }));
  const fixture = await loadPanel();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing memory page');
  const factButton = element.querySelector<HTMLButtonElement>('.fact');
  if (!factButton) throw new Error('Missing fact button');
  factButton.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Access changed');
  expect(visibleText(fixture)).not.toContain('Private fact text.');
});
