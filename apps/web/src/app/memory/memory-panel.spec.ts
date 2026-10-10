import { Directive, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';
import { Overlay } from '../ui/overlay';

@Directive({ selector: 'dialog[ocOverlay]', exportAs: 'ocOverlay', standalone: true })
class OverlayStub {
  readonly ocOverlay = input(false);
  readonly returnFocusTo = input<HTMLElement>();
  readonly dismissDisabled = input(false);
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

it('cancels the store form without making a request', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }));
  const fixture = await loadPanel();
  const requestCount = vi.mocked(fetch).mock.calls.length;
  fixture.componentInstance['openStore']();
  fixture.detectChanges();
  fixture.componentInstance['cancelStore']();
  fixture.detectChanges();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(requestCount);
});

it('uses UTF-8 bytes and keeps Preference unavailable outside person memory', async () => {
  stubReplies(response(200, { scopes: [{ ...personalScope(), scopeKind: 'group' }] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }));
  const fixture = await loadPanel();
  fixture.componentInstance['storeText'].set('é'.repeat(2049));
  expect(fixture.componentInstance['storeBytes']()).toBe(4098);
  expect(fixture.componentInstance['storeValidation']()).toContain('4,096 UTF-8 bytes');
  fixture.componentInstance['storeText'].set('A useful group fact');
  fixture.componentInstance['storeKind'].set('preference');
  expect(fixture.componentInstance['storeValidation']()).toContain('only be saved');
});

it('shows a saved receipt only after the write is accepted', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(200, { outcome: 'saved' }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Remember this detail');
  await fixture.componentInstance['saveFact']();
  fixture.detectChanges();
  expect(fixture.componentInstance['storeState']()).toBe('saved');
  expect(visibleText(fixture)).toContain('Saved in Only you');
  const request = vi.mocked(fetch).mock.calls[2];
  expect(request?.[1]?.method).toBe('POST');
  expect(request?.[1]?.body).toEqual(expect.stringContaining('Remember this detail'));
});

it('sends only a source already returned as available by the detail read', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(200, { outcome: 'saved' }));
  const fixture = await loadPanel();
  fixture.componentInstance['sources'].set([
    { status: 'available', label: 'Checked conversation', reference: {
      conversationId: 'chat-one', messageId: 'message-one',
    } },
    { status: 'refused', label: 'Unavailable conversation', reference: {
      conversationId: 'private-chat', messageId: 'private-message',
    } },
  ]);
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('A source linked by the server');
  await fixture.componentInstance['saveFact']();
  const body = vi.mocked(fetch).mock.calls[2]?.[1]?.body;
  expect(body).toEqual(expect.stringContaining('message-one'));
  expect(body).not.toEqual(expect.stringContaining('private-message'));
});

it('checks an unknown command with GET and never sends it again', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    new Response('', { status: 503 }),
    response(200, { outcome: 'saved' }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Check the original request');
  await fixture.componentInstance['saveFact']();
  expect(fixture.componentInstance['storeState']()).toBe('unknown');
  await fixture.componentInstance['checkStoreStatus']();
  expect(fixture.componentInstance['storeState']()).toBe('saved');
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls[2]?.[1]?.method).toBe('POST');
  expect(calls[3]?.[1]?.method).toBeUndefined();
  expect(requestUrl(calls[3]?.[0])).toContain('/changes/mem_');
});

it('keeps an unknown command available after Cancel is pressed', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    new Response('', { status: 503 }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Check the original request');
  await fixture.componentInstance['saveFact']();
  const originalCommandId = fixture.componentInstance['storeCommandId']();
  fixture.componentInstance['cancelStore']();
  expect(fixture.componentInstance['storeOpen']()).toBe(true);
  expect(fixture.componentInstance['storeState']()).toBe('unknown');
  expect(fixture.componentInstance['storeCommandId']()).toBe(originalCommandId);
  await fixture.componentInstance['checkStoreStatus']();
  expect(requestUrl(vi.mocked(fetch).mock.calls[3]?.[0])).toContain(originalCommandId);
});

it('shows the validation explanation beside invalid stored text', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('é'.repeat(2049));
  fixture.detectChanges();
  const field = pageElement(fixture).querySelector<HTMLTextAreaElement>('.fact-entry textarea');
  expect(visibleText(fixture)).toContain('Facts must be 1 to 4,096 UTF-8 bytes.');
  expect(field?.getAttribute('aria-invalid')).toBe('true');
});

it('clears every store field and pending command when the write is refused', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(403, { status: 'refused' }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Private draft');
  fixture.componentInstance['storeCommandId'].set('mem_pending');
  fixture.componentInstance['storeSource'].set({
    conversationId: 'private-chat', messageId: 'private-message',
  });
  await fixture.componentInstance['saveFact']();
  expect(fixture.componentInstance['storeOpen']()).toBe(false);
  expect(fixture.componentInstance['storeText']()).toBe('');
  expect(fixture.componentInstance['storeCommandId']()).toBe('');
  expect(fixture.componentInstance['storeSource']()).toBeUndefined();
  expect(fixture.componentInstance['storeState']()).toBe('editing');
});

it('clears the store draft and command when the requester changes', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    response(200, { scopes: [] }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Another person’s draft');
  fixture.componentInstance['storeCommandId'].set('mem_pending');
  fixture.componentInstance['storeSource'].set({
    conversationId: 'private-chat', messageId: 'private-message',
  });
  fixture.componentRef.setInput('requesterId', 'another-member');
  fixture.detectChanges();
  await fixture.whenStable();
  expect(fixture.componentInstance['storeOpen']()).toBe(false);
  expect(fixture.componentInstance['storeText']()).toBe('');
  expect(fixture.componentInstance['storeCommandId']()).toBe('');
  expect(fixture.componentInstance['storeSource']()).toBeUndefined();
});

it('waits for Retry-After and retries only a definitely busy command', async () => {
  stubReplies(response(200, { scopes: [personalScope()] }),
    response(200, { scopeId: 'scope', facts: [], returnedCount: 0, nextCursor: null }),
    new Response(JSON.stringify({ reason: 'memory_busy' }), {
      status: 503, headers: { 'retry-after': '1' },
    }),
    response(409, { outcome: 'failed' }));
  const fixture = await loadPanel();
  fixture.componentInstance['openStore']();
  fixture.componentInstance['storeText'].set('Try this after the busy slot clears');
  await fixture.componentInstance['saveFact']();
  expect(fixture.componentInstance['storeState']()).toBe('busy');
  vi.useFakeTimers();
  const retry = fixture.componentInstance['retryBusy']();
  await vi.advanceTimersByTimeAsync(1000);
  await retry;
  vi.useRealTimers();
  expect(fixture.componentInstance['storeState']()).toBe('failed');
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls[2]?.[1]?.method).toBe('POST');
  expect(calls[3]?.[1]?.method).toBe('POST');
  expect(calls[2]?.[1]?.body).toBe(calls[3]?.[1]?.body);
});
