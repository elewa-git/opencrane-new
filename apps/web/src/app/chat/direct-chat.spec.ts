import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectChat } from './direct-chat';
import { RANDOM_SOURCE, SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

type RequestRecord = { url: string; method: string; body?: Record<string, unknown> };

const alice = { memberId: 'alice', displayName: 'Alex Kim' };
const colleagues = [
  { memberId: 'bob', displayName: 'Grace Achieng' },
  { memberId: 'carol', displayName: 'Chris Njeri' },
];

function conversation(conversationId: string, colleagueId: string) {
  return {
    conversationId, createdBy: 'alice', createdAt: '2026-10-06T09:00:00Z',
    mode: 'direct', participantIds: ['alice', colleagueId],
  };
}

function eventRow(position: number, authorId: string, text: string) {
  return {
    id: `event-${position}`, position, type: 'message.posted',
    time: `2026-10-06T09:0${position}:00Z`,
    data: { authorId, text, contentType: 'text' },
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function stringProperty(value: unknown, key: string): string | undefined {
  const record = objectValue(value);
  const property = record?.[key];
  return typeof property === 'string' ? property : undefined;
}

function recordSocketMessage(sentMessages: string[]): (data: string) => void {
  return function recordMessage(data: string): void {
    sentMessages.push(data);
  };
}

function readRequest(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
  const method = init?.method ?? 'GET';
  let body: Record<string, unknown> | undefined;
  if (typeof init?.body === 'string') body = objectValue(JSON.parse(init.body) as unknown);
  if (body) return { url, method, body };
  return { url, method };
}

function createFetchFixture() {
  const requests: RequestRecord[] = [];
  const sockets: SocketLike[] = [];
  const sentSocketMessages: string[] = [];
  const savedConversations = [conversation('existing', 'bob')];
  const savedMessages = new Map<string, ReturnType<typeof eventRow>[]>([
    ['existing', [eventRow(1, 'bob', 'Is the Tuesday slot still open?'),
      eventRow(2, 'alice', 'Yes, I will confirm by noon.')]],
  ]);
  let messageFailure: 'none' | 'lost' = 'none';
  let holdMessageReply: (() => void) | undefined;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = readRequest(input, init);
    requests.push(request);
    const url = new URL(request.url, location.origin);
    if (url.pathname === '/api/chat') return reply({ ...alice, assistantId: 'assistant-not-used' });
    if (url.pathname === '/api/chat/colleagues') {
      const query = url.searchParams.get('q')?.toLowerCase() ?? '';
      const rows = colleagues.filter((person) =>
        person.displayName?.toLowerCase().includes(query));
      return reply({ rows, next: null });
    }
    if (url.pathname === '/api/conversations' && request.method === 'GET') {
      return reply({ rows: savedConversations });
    }
    if (url.pathname === '/api/conversations' && request.method === 'POST') {
      const body = request.body ?? {};
      savedConversations.push(conversation(String(body['conversationId']), String(body['colleagueId'])));
      return reply({ status: 'appended', sequence: 1 });
    }
    if (url.pathname.endsWith('/messages') && request.method === 'GET') {
      const conversationId = url.pathname.split('/').at(-2) ?? '';
      const rows = savedMessages.get(conversationId) ?? [];
      return reply({ rows, position: rows.length, generation: 1,
        computerState: 'not_applicable' });
    }
    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      const conversationId = url.pathname.split('/').at(-2) ?? '';
      const body = request.body ?? {};
      const rows = savedMessages.get(conversationId) ?? [];
      rows.push(eventRow(rows.length + 1, 'alice', String(body['text'])));
      savedMessages.set(conversationId, rows);
      if (holdMessageReply) await new Promise<void>(holdMessageReply);
      if (messageFailure === 'lost') throw new TypeError('Connection lost after append');
      return reply({ status: 'appended', sequence: rows.length + 1 });
    }
    if (url.pathname.includes('/changes/')) {
      const commandId = url.pathname.split('/').at(-1) ?? '';
      return reply({ status: 'appended', conversationId: 'existing', commandId,
        type: 'message.posted', sequence: 2,
        projection: { content: 'current', iam: 'current' } });
    }
    if (/turn|model|agent/i.test(url.pathname)) {
      throw new Error(`Direct chat requested AI endpoint ${url.pathname}`);
    }
    return reply({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const socketFactory = () => {
    const socket: SocketLike = {
      readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
      send: recordSocketMessage(sentSocketMessages), close: vi.fn(),
    };
    sockets.push(socket);
    return socket;
  };
  return {
    requests,
    sockets,
    sentSocketMessages,
    socketFactory,
    failNextMessageReply() { messageFailure = 'lost'; },
    holdNextMessageReply(resolve: () => void) { holdMessageReply = resolve; },
    releaseMessageReply() { holdMessageReply?.(); holdMessageReply = undefined; },
  };
}

async function mount(api = createFetchFixture()): Promise<ComponentFixture<DirectChat>> {
  history.replaceState({}, '', '/workspace/direct');
  TestBed.configureTestingModule({ imports: [DirectChat], providers: [
    { provide: SOCKET_FACTORY, useValue: api.socketFactory },
    { provide: RANDOM_SOURCE, useValue: () => 0 },
  ] });
  const fixture = TestBed.createComponent(DirectChat);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('Grace Achieng'));
  return fixture;
}

function root(fixture: ComponentFixture<DirectChat>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected the direct chat screen');
  return element;
}

function searchField(fixture: ComponentFixture<DirectChat>): HTMLInputElement {
  const field = root(fixture).querySelector<HTMLInputElement>('#colleague-search');
  if (!field) throw new Error('Expected colleague search');
  return field;
}

function messageField(fixture: ComponentFixture<DirectChat>): HTMLTextAreaElement {
  const field = root(fixture).querySelector<HTMLTextAreaElement>('textarea');
  if (!field) throw new Error('Expected message field');
  return field;
}

async function chooseColleague(fixture: ComponentFixture<DirectChat>, name: string) {
  const candidate = [...root(fixture).querySelectorAll('button.colleague-option')]
    .find((button) => button.textContent?.includes(name));
  if (!(candidate instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${name}; screen shows ${root(fixture).textContent}`);
  }
  candidate.click();
  fixture.detectChanges();
  await fixture.whenStable();
}

function enterMessage(fixture: ComponentFixture<DirectChat>, value: string): void {
  const field = messageField(fixture);
  field.focus();
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  fixture.detectChanges();
}

async function settle(fixture: ComponentFixture<DirectChat>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('searches authorised colleagues and renders an ordered human transcript without assistant controls',
  async () => {
    const fixture = await mount();
    const existing = [...root(fixture).querySelectorAll<HTMLButtonElement>(
      'button.conversation-row',
    )]
      .find((button) => button.textContent?.includes('Grace Achieng'));
    existing?.click();
    await vi.waitFor(() => expect(root(fixture).textContent)
      .toContain('Is the Tuesday slot still open?'));
    const rootElement = root(fixture);
    expect(rootElement.textContent).toContain('Is the Tuesday slot still open?');
    expect(rootElement.textContent).toContain('Yes');
    expect(rootElement.querySelector('.change-recipient')).not.toBeNull();
    expect(rootElement.querySelector('[aria-label="Stop"]')).toBeNull();
    expect(rootElement.textContent).not.toContain('Memory');
    expect(rootElement.textContent).not.toContain('Agent working');
    expect(rootElement.querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
    expect(rootElement.querySelector('.conversation-row')?.textContent).toContain('Grace Achieng');
    fixture.destroy();
  });

it('keeps the first pending message separate and blocks a second message while it applies', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const existing = root(fixture).querySelector<HTMLButtonElement>('.conversation-row');
  existing?.click();
  await settle(fixture);
  const submitted = new Promise<void>((resolve) => api.holdNextMessageReply(resolve));
  enterMessage(fixture, 'First message');
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('Sending message'));
  expect(messageField(fixture).readOnly).toBe(true);
  expect(root(fixture).querySelector('.change-recipient')?.hasAttribute('disabled')).toBe(true);
  expect(api.requests.filter((request) => request.method === 'POST'
    && request.url.endsWith('/messages')).length).toBe(1);
  api.releaseMessageReply();
  await submitted;
  await settle(fixture);
  fixture.destroy();
});

it('subscribes after history and ignores duplicate event positions', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const conversationRow = root(fixture).querySelector<HTMLButtonElement>('.conversation-row');
  conversationRow?.click();
  await vi.waitFor(() => expect(root(fixture).textContent)
    .toContain('Is the Tuesday slot still open?'));
  const socket = api.sockets.at(-1);
  if (!socket) throw new Error('Expected a direct conversation socket');
  socket.onopen?.(new Event('open'));
  fixture.detectChanges();
  const sentSubscription = api.sentSocketMessages[0];
  const subscription = objectValue(JSON.parse(String(sentSubscription ?? '{}')) as unknown);
  expect(subscription).toMatchObject({
    type: 'subscribe', conversationId: 'existing', since: 2,
  });
  const event = {
    version: 1, topic: 'conversation', conversationId: 'existing', type: 'event',
    position: 3, generation: 1,
    row: eventRow(3, 'bob', 'I will confirm before lunch.'),
  };
  const incoming = new MessageEvent('message', { data: JSON.stringify(event) });
  socket.onmessage?.(incoming);
  socket.onmessage?.(incoming);
  await vi.waitFor(() => expect(root(fixture).textContent)
    .toContain('I will confirm before lunch.'));
  expect(root(fixture).querySelectorAll('.message')).toHaveLength(3);
  expect(api.requests.filter((request) => /turn|model/i.test(
    new URL(request.url, location.origin).pathname,
  ))).toHaveLength(0);
  fixture.destroy();
});

it('keeps a lost reply unknown, checks the same command and clears only after its receipt', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  api.failNextMessageReply();
  enterMessage(fixture, 'Please check Tuesday');
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('couldn\'t tell'));
  const messageRequest = api.requests.find((request) => request.method === 'POST'
    && request.url.endsWith('/messages'));
  expect(messageRequest?.body?.['text']).toBe('Please check Tuesday');
  const commandId = stringProperty(messageRequest?.body, 'id');
  if (!commandId) throw new Error('Expected the sent command id');
  const check = [...root(fixture).querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Check status');
  check?.click();
  await settle(fixture);
  expect(api.requests.filter((request) => request.method === 'POST'
    && request.url.endsWith('/messages'))).toHaveLength(1);
  expect(api.requests.some((request) => request.url.includes(`/changes/${commandId}`))).toBe(true);
  await vi.waitFor(() => expect(root(fixture).textContent)
    .toContain('Please check Tuesday'));
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
});

it('keeps Enter in colleague search from sending and leaves a healthy refresh quiet', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const field = searchField(fixture);
  field.value = 'Grace';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(fixture);
  expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  const readsBeforeRefresh = api.requests.filter((request) =>
    request.method === 'GET' && new URL(request.url, location.origin).pathname === '/api/conversations',
  ).length;
  const refresh = [...root(fixture).querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Refresh');
  if (!refresh) throw new Error('Expected a refresh button for the healthy list');
  refresh.click();
  await vi.waitFor(() => expect(api.requests.filter((request) =>
    request.method === 'GET'
      && new URL(request.url, location.origin).pathname === '/api/conversations',
  ).length).toBeGreaterThan(readsBeforeRefresh));
  await settle(fixture);
  expect(root(fixture).textContent).not.toContain('unavailable');
  expect(root(fixture).querySelector('.refresh-error')).toBeNull();
  expect(root(fixture).querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
  fixture.destroy();
});

it('sends one direct message when Enter is pressed in the message field', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  enterMessage(fixture, 'A message sent with Enter');
  await vi.waitFor(() => expect(messageField(fixture).value).toBe(''));
  const sentMessages = api.requests.filter((request) => request.method === 'POST'
    && request.url.endsWith('/messages'));
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]?.body?.['text']).toBe('A message sent with Enter');
  fixture.destroy();
});

it('creates two direct chats in one visit with a fresh command for each message', async () => {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  enterMessage(fixture, 'First chat');
  await vi.waitFor(() => expect(messageField(fixture).value).toBe(''));
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('First chat'));
  await vi.waitFor(() => expect(root(fixture).querySelector('.change-recipient')).not.toBeNull());
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  const search = searchField(fixture);
  search.value = 'Chris';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('Chris Njeri'));
  const secondCandidate = [...root(fixture).querySelectorAll<HTMLButtonElement>(
    '.colleague-option',
  )].find((button) => button.textContent?.includes('Chris Njeri'));
  secondCandidate?.click();
  fixture.detectChanges();
  enterMessage(fixture, 'Second chat @agent');
  await vi.waitFor(() => expect(messageField(fixture).value).toBe(''));
  const creations = api.requests.filter((request) =>
    request.method === 'POST' && request.url.endsWith('/conversations'));
  const sends = api.requests.filter((request) =>
    request.method === 'POST' && request.url.endsWith('/messages'));
  expect(creations).toHaveLength(2);
  expect(sends.map((request) => request.body?.['text']))
    .toEqual(['First chat', 'Second chat @agent']);
  expect(new Set([...creations, ...sends].map((request) => request.body?.['id'])).size).toBe(4);
  const turnRequests = api.requests.filter((request) => /turn/i.test(request.url));
  const modelRequests = api.requests.filter((request) => /model/i.test(request.url));
  expect(turnRequests).toHaveLength(0);
  expect(modelRequests).toHaveLength(0);
  fixture.destroy();
});

function searchFor(fixture: ComponentFixture<DirectChat>, query: string): void {
  const field = root(fixture).querySelector<HTMLInputElement>('#colleague-search');
  if (!field) throw new Error('Expected colleague search');
  field.value = query;
  field.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

async function failedSearchIsVisible(status: number): Promise<void> {
  const fixture = await mount();
  function refuseSearch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status }));
  }
  vi.stubGlobal('fetch', vi.fn(refuseSearch));
  searchFor(fixture, 'gr');
  await fixture.whenStable();
  fixture.detectChanges();
  const panel = root(fixture).querySelector('.recipient-panel');
  expect(panel?.textContent).toContain('Could not search colleagues. Try again.');
  expect(panel?.textContent).not.toContain('No colleagues match');
  expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(0);
  fixture.destroy();
}

async function showsUnavailableSearch(): Promise<void> {
  await failedSearchIsVisible(503);
}
it('shows a visible search failure after a 503', showsUnavailableSearch);

async function showsRefusedSearch(): Promise<void> {
  await failedSearchIsVisible(403);
}
it('shows a visible search failure after a refused read', showsRefusedSearch);

async function ignoresOlderSearchReply(): Promise<void> {
  const fixture = await mount();
  let releaseOlder: ((response: Response) => void) | undefined;
  function holdOlder(resolve: (response: Response) => void): void {
    releaseOlder = resolve;
  }
  const olderReply = new Promise<Response>(holdOlder);
  function searchReply(input: string): Promise<Response> {
    if (input.includes('q=g&')) return olderReply;
    const data = { rows: [{ memberId: 'grace', displayName: 'Grace Achieng' }], next: null };
    return Promise.resolve(new Response(JSON.stringify(data)));
  }
  vi.stubGlobal('fetch', vi.fn(searchReply));
  searchFor(fixture, 'g');
  searchFor(fixture, 'gr');
  function newerReplyIsShown(): void {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(1);
  }
  await vi.waitFor(newerReplyIsShown);
  if (!releaseOlder) throw new Error('Expected the older request');
  releaseOlder(colleaguesReply());
  function nextTask(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(1);
  expect(root(fixture).textContent).not.toContain('Chris Njeri');
  fixture.destroy();
}
it('ignores an older search reply that arrives after the newer reply', ignoresOlderSearchReply);
