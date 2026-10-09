import { Directive, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';
import { Overlay } from '../ui/overlay';

@Directive({ selector: 'dialog[ocOverlay]', exportAs: 'ocOverlay', standalone: true })
class OverlayStub {
  readonly ocOverlay = input(false);
  readonly returnFocusTo = input<HTMLElement>();
  readonly overlayClosed = output<void>();
  readonly titleId = 'memory-detail-title';
}

function visibleText(fixture: { nativeElement: unknown }): string {
  const element = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) return '';
  return element.textContent ?? '';
}

function pageElement(fixture: ComponentFixture<MemoryPanel>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing memory page');
  return element;
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
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
  return { memoryId: 'fact-one', revision: 1, text, kind: 'fact' as const, pinned: false,
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
  TestBed.overrideComponent(MemoryPanel, {
    remove: { imports: [Overlay] },
    add: { imports: [OverlayStub] },
  });
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

it('purges facts and ignores a pending reply when access is revoked', async () => {
  let finishList: ((response: Response) => void) | undefined;
  const savedFact = fact('Private pending fact.');
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (requestUrl(input).includes('/facts?')) {
      return new Promise<Response>((resolve) => { finishList = resolve; });
    }
    return Promise.resolve(response(200, { scopes: [personalScope()] }));
  }));
  const fixture = await loadPanel();
  fixture.componentInstance['selectedFact'].set(savedFact);
  fixture.componentInstance['facts'].set([savedFact]);
  fixture.componentInstance['sources'].set([{ status: 'available', label: 'Private source' }]);
  fixture.componentInstance['revoke']();
  finishList?.(response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1,
    nextCursor: null }));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).not.toContain('Private pending fact.');
  expect(visibleText(fixture)).not.toContain('Private source');
  expect(fixture.componentInstance['facts']()).toEqual([]);
  expect(fixture.componentInstance['sources']()).toEqual([]);
});

it('clears all rendered memory when the workspace reports denied access', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [fact('Workspace private fact.')],
      returnedCount: 1, nextCursor: null }));
  const fixture = await loadPanel();
  fixture.componentRef.setInput('accessDenied', true);
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Access changed');
  expect(visibleText(fixture)).not.toContain('Workspace private fact.');
  expect(fixture.componentInstance['scopes']()).toEqual([]);
  expect(fixture.componentInstance['facts']()).toEqual([]);
  expect(fixture.componentInstance['query']()).toBe('');
  expect(fixture.componentInstance['cursor']()).toBeNull();
  expect(fixture.componentInstance['nextCursor']()).toBeNull();
});

it('shows rejected search input beside the search field', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(422, { status: 'invalid' }));
  const fixture = await loadPanel();
  const element = pageElement(fixture);
  const search = element.querySelector<HTMLInputElement>('input[type="search"]');
  if (!search) throw new Error('Missing search field');
  search.value = 'one two three four five six seven eight nine';
  search.dispatchEvent(new Event('input'));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Search input is invalid');
  expect(search.getAttribute('aria-describedby')).toBe('memory-search-error');
});

it('restarts from the first page after the saved facts change', async () => {
  const savedFact = fact('First page fact.');
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1,
      nextCursor: 'old-cursor' }),
    response(409, { status: 'refused' }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1,
      nextCursor: 'new-cursor' }));
  const fixture = await loadPanel();
  const element = pageElement(fixture);
  element.querySelector<HTMLButtonElement>('.next')?.click();
  await fixture.whenStable();
  fixture.detectChanges();
  const oldPageUrl = requestUrl(vi.mocked(fetch).mock.calls[2]?.[0]);
  const refreshedPageUrl = requestUrl(vi.mocked(fetch).mock.calls[3]?.[0]);
  expect(oldPageUrl).toContain('old-cursor');
  expect(refreshedPageUrl).not.toContain('old-cursor');
  expect(fixture.componentInstance['nextCursor']()).toBe('new-cursor');
});

it('shows the detail audience and saved fact metadata', async () => {
  const savedFact = fact('A shared project fact.');
  savedFact.revision = 4;
  savedFact.pinned = true;
  stubReplies(response(200, { scopes: [{ ...personalScope(), scopeKind: 'group',
    audience: { kind: 'group', ownerId: 'group-a' } }] }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1, nextCursor: null }),
    response(200, { scopeId: 'scope', fact: savedFact, sources: [] }));
  const fixture = await loadPanel();
  const element = pageElement(fixture);
  element.querySelector<HTMLButtonElement>('.fact')?.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('Shared with group group-a');
  expect(visibleText(fixture)).toContain('Revision');
  expect(visibleText(fixture)).toContain('4');
  expect(visibleText(fixture)).toContain('Pinned for initial context; loading is not enabled yet');
  expect(visibleText(fixture)).toContain('2 October 2026');
  const detailDialog = element.querySelector<HTMLDialogElement>('.detail');
  expect(detailDialog?.getAttribute('aria-labelledby')).toBe('memory-detail-title');
});

it('shows a missing fact separately from a service failure', async () => {
  const savedFact = fact('The fact has since been removed.');
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [savedFact], returnedCount: 1,
      nextCursor: null }),
    response(200, { status: 'unavailable', scopeId: 'scope', memoryId: 'fact-one',
      revision: 1, reason: 'missing' }));
  const fixture = await loadPanel();
  const element = pageElement(fixture);
  element.querySelector<HTMLButtonElement>('.fact')?.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(visibleText(fixture)).toContain('This fact or its text is no longer available.');
  expect(visibleText(fixture)).not.toContain('Details are unavailable right now.');
});
