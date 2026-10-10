import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { ChatComposer } from './composer';
import { DirectChat } from './direct-chat';
import { RANDOM_SOURCE, SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

type ReplyOverride = (request: RequestRecord) => Response | Promise<Response> | undefined;

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
    time: '2026-10-06T09:00:00Z',
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
  let url: string;
  if (typeof input === 'string') url = input;
  else if (input instanceof Request) url = input.url;
  else url = input.toString();
  const method = init?.method ?? 'GET';
  let body: Record<string, unknown> | undefined;
  if (typeof init?.body === 'string') body = objectValue(JSON.parse(init.body) as unknown);
  if (body) return { url, method, body };
  return { url, method };
}

function createFetchFixture() {
  const requests: RequestRecord[] = [];
  const requestCounts = { turns: 0, models: 0 };
  let replyOverride: ReplyOverride | undefined;
  const sockets: SocketLike[] = [];
  const sentSocketMessages: string[] = [];
  const closedSockets: SocketLike[] = [];
  const savedConversations = [conversation('existing', 'bob')];
  const savedMessages = new Map<string, ReturnType<typeof eventRow>[]>([
    ['existing', [eventRow(1, 'bob', 'Is the Tuesday slot still open?'),
      eventRow(2, 'alice', 'Yes, I will confirm by noon.')]],
  ]);
  let messageFailure: 'none' | 'lost' = 'none';
  let notifyMessageStarted: (() => void) | undefined;
  let releaseHeldMessage: (() => void) | undefined;
  async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = readRequest(input, init);
    requests.push(request);
    const url = new URL(request.url, location.origin);
    if (request.method === 'POST' && url.pathname.endsWith('/messages')
      && (request.body?.['executionMode'] !== undefined
        || request.body?.['stopTurnId'] !== undefined)) requestCounts.turns += 1;
    if (request.method === 'POST' && url.pathname === '/v1/responses') requestCounts.models += 1;
    const overridden = replyOverride?.(request);
    if (overridden) return overridden;
    if (url.pathname === '/api/chat') return reply({ ...alice, assistantId: 'assistant-not-used' });
    if (url.pathname === '/api/chat/groups') return reply({ rows: [], next: null });
    if (url.pathname === '/api/chat/colleagues') {
      const query = url.searchParams.get('q')?.toLowerCase() ?? '';
      function matchesQuery(person: (typeof colleagues)[number]): boolean {
        const name = person.displayName.toLowerCase();
        return name.includes(query);
      }
      const rows = colleagues.filter(matchesQuery);
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
      if (notifyMessageStarted) {
        notifyMessageStarted();
        function hold(resolve: () => void): void {
    releaseHeldMessage = resolve;
  }
        await new Promise<void>(hold);
      }
      if (messageFailure === 'lost') throw new TypeError('Connection lost after append');
      return reply({ status: 'appended', sequence: rows.length + 1 });
    }
    if (url.pathname.includes('/changes/')) {
      const commandId = url.pathname.split('/').at(-1) ?? '';
      return reply({ status: 'appended', conversationId: 'existing', commandId,
        type: 'message.posted', sequence: 2,
        projection: { content: 'current', iam: 'current' } });
    }
    return reply({});
  }
  const fetchMock = vi.fn(fixtureFetch);
  vi.stubGlobal('fetch', fetchMock);
  function socketFactory(): SocketLike {
    const socket: SocketLike = {
      readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
      send: recordSocketMessage(sentSocketMessages), close: closeSocket,
    };
    function closeSocket(): void {
      closedSockets.push(socket);
    }
    sockets.push(socket);
    function openSocket(): void {
      socket.onopen?.(new Event('open'));
    }
    queueMicrotask(openSocket);
    return socket;
  }
  return {
    requests,
    requestCounts,
    seedExistingHistory(size: number) {
      const rows: ReturnType<typeof eventRow>[] = [];
      for (let position = 1; position <= size; position++) {
        let text = `Older message ${position}`;
        if (position === 1) text = 'Is the Tuesday slot still open?';
        rows.push(eventRow(position, 'bob', text));
      }
      savedMessages.set('existing', rows);
    },
    override(handler: ReplyOverride) { replyOverride = handler; },
    clearOverride() { replyOverride = undefined; },
    sockets,
    sentSocketMessages,
    closedSockets,
    addGroupConversation() {
      savedConversations.push({ conversationId: 'group-chat', createdBy: 'alice',
        createdAt: '2026-10-06T09:00:00Z', mode: 'group',
        participantIds: ['alice', 'bob', 'carol'] });
      savedMessages.set('group-chat', [eventRow(1, 'bob', 'Hello everyone'),
        eventRow(2, 'carol', '@agent is just text')]);
    },
    socketFactory,
    failNextMessageReply() { messageFailure = 'lost'; },
    holdNextMessageReply(resolve: () => void) { notifyMessageStarted = resolve; },
    releaseMessageReply() {
      releaseHeldMessage?.();
      releaseHeldMessage = undefined;
      notifyMessageStarted = undefined;
    },
  };
}

async function mountWithoutReady(
  api = createFetchFixture(), requestedId = '',
): Promise<ComponentFixture<DirectChat>> {
  const address = requestedId
    ? `/workspace/direct?conversation=${encodeURIComponent(requestedId)}`
    : '/workspace/direct';
  history.replaceState({}, '', address);
  TestBed.configureTestingModule({ imports: [DirectChat], providers: [
    { provide: SOCKET_FACTORY, useValue: api.socketFactory },
    { provide: RANDOM_SOURCE, useValue: fixedRandom },
  ] });
  const fixture = TestBed.createComponent(DirectChat);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

async function mount(api = createFetchFixture()): Promise<ComponentFixture<DirectChat>> {
  const fixture = await mountWithoutReady(api);
  function hasDirectory(): void {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Grace Achieng');
  }
  await vi.waitFor(hasDirectory);
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
  function hasName(button: Element): boolean {
    return Boolean(button.textContent?.includes(name));
  }
  const options = Array.from(root(fixture).querySelectorAll('button.colleague-option'));
  const candidate = options.find(hasName);
  if (!(candidate instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${name}; screen shows ${root(fixture).textContent}`);
  }
  candidate.click();
  fixture.detectChanges();
  await fixture.whenStable();
  const useSelection = root(fixture).querySelector<HTMLButtonElement>('.finish-selection');
  if (!useSelection) throw new Error('Expected the recipient review action');
  useSelection.click();
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
  function nextTask(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function cleanUpDirectChatTest(): void {
  vi.useRealTimers();
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

afterEach(cleanUpDirectChatTest);

async function rendersHumanTranscript(): Promise<void> {
    const fixture = await mount();
    await openExisting(fixture);
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
  }

it('searches authorised colleagues and renders an ordered human transcript without assistant controls',
  rendersHumanTranscript);

async function blocksPendingMessage(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const existing = root(fixture).querySelector<HTMLButtonElement>('.conversation-row');
  existing?.click();
  await settle(fixture);
  function holdPending(resolve: () => void): void {
    api.holdNextMessageReply(resolve);
  }
  const submitted = new Promise<void>(holdPending);
  enterMessage(fixture, 'First message');
  await waitForText(fixture, 'Sending message');
  expect(messageField(fixture).readOnly).toBe(true);
  expect(root(fixture).querySelector('.change-recipient')?.hasAttribute('disabled')).toBe(true);
  expect(messagePosts(api)).toHaveLength(1);
  api.releaseMessageReply();
  await submitted;
  await settle(fixture);
  fixture.destroy();
}

it('keeps the first pending message separate and blocks a second message while it applies', blocksPendingMessage);

async function resumesSocketHistory(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const conversationRow = root(fixture).querySelector<HTMLButtonElement>('.conversation-row');
  conversationRow?.click();
  await waitForText(fixture, 'Is the Tuesday slot still open?');
  const socket = api.sockets.at(-1);
  if (!socket) throw new Error('Expected a direct conversation socket');
  socket.onopen?.(new Event('open'));
  await settle(fixture);
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
  await waitForText(fixture, 'I will confirm before lunch.');
  expect(root(fixture).querySelectorAll('.message')).toHaveLength(3);
  assertOnlyHumanRequests(api);
  fixture.destroy();
}

it('subscribes after history and ignores duplicate event positions', resumesSocketHistory);

async function checksLostMessage(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  api.failNextMessageReply();
  enterMessage(fixture, 'Please check Tuesday');
  await waitForText(fixture, "couldn't tell");
  const messageRequest = messagePosts(api)[0];
  expect(messageRequest?.body?.['text']).toBe('Please check Tuesday');
  const commandId = stringProperty(messageRequest?.body, 'id');
  if (!commandId) throw new Error('Expected the sent command id');
  buttonNamed(fixture, 'Check status').click();
  await settle(fixture);
  expect(messagePosts(api)).toHaveLength(1);
  function checksCommand(request: RequestRecord): boolean {
    return request.url.includes(`/changes/${commandId}`);
  }
  expect(api.requests.some(checksCommand)).toBe(true);
  await waitForText(fixture, 'Please check Tuesday');
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
}

it('keeps a lost reply unknown, checks the same command and clears only after its receipt', checksLostMessage);

async function refreshesHealthyListWithoutSending(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const field = searchField(fixture);
  field.value = 'Grace';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(fixture);
  expect(api.requests.filter(isPost)).toHaveLength(0);
  const readsBeforeRefresh = api.requests.filter(isListRead).length;
  buttonNamed(fixture, 'Refresh').click();
  function hasRefreshed(): void {
    expect(api.requests.filter(isListRead).length).toBeGreaterThan(readsBeforeRefresh);
  }
  await vi.waitFor(hasRefreshed);
  await settle(fixture);
  expect(root(fixture).textContent).not.toContain('unavailable');
  expect(root(fixture).querySelector('.refresh-error')).toBeNull();
  expect(root(fixture).querySelectorAll('[role="status"][aria-live="polite"]')).toHaveLength(1);
  fixture.destroy();
}

it('keeps Enter in colleague search from sending and leaves a healthy refresh quiet', refreshesHealthyListWithoutSending);

async function sendsOnEnter(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  enterMessage(fixture, 'A message sent with Enter');
  await waitForEmptyDraft(fixture);
  const sentMessages = messagePosts(api);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]?.body?.['text']).toBe('A message sent with Enter');
  fixture.destroy();
}

it('sends one direct message when Enter is pressed in the message field', sendsOnEnter);

async function createsTwoChats(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  enterMessage(fixture, 'First chat');
  await waitForEmptyDraft(fixture);
  await waitForText(fixture, 'First chat');
  fixture.detectChanges();
  expect(root(fixture).querySelector('.change-recipient')).not.toBeNull();
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  const search = searchField(fixture);
  search.value = 'Chris';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await waitForText(fixture, 'Chris Njeri');
  await chooseColleague(fixture, 'Chris Njeri');
  enterMessage(fixture, 'Second chat @agent');
  await waitForEmptyDraft(fixture);
  const creations = api.requests.filter(isCreatePost);
  const sends = messagePosts(api);
  expect(creations).toHaveLength(2);
  expect(sends.map(requestText))
    .toEqual(['First chat', 'Second chat @agent']);
  const commands = [...creations, ...sends];
  const commandIds = commands.map(requestId);
  expect(new Set(commandIds).size).toBe(4);
  assertOnlyHumanRequests(api);
  fixture.destroy();
}

it('creates two direct chats in one visit with a fresh command for each message', createsTwoChats);

it('creates group mode for several people only after the first message', createsGroupFromPeople);

async function requiresReviewBeforeSendingToMoreThanThreePeople(): Promise<void> {
  const api = createFetchFixture();
  const audience = [
    { memberId: 'bob', displayName: 'Grace Achieng' },
    { memberId: 'carol', displayName: 'Chris Njeri' },
    { memberId: 'dina', displayName: 'Dina Kamau' },
    { memberId: 'eric', displayName: 'Eric Maina' },
  ];
  api.override(function listFourColleagues(request: RequestRecord) {
    if (request.url.startsWith('/api/chat/colleagues')) {
      return reply({ rows: audience, next: null });
    }
    return undefined;
  });
  const fixture = await mount(api);
  const rootElement = root(fixture);
  const options = rootElement.querySelectorAll<HTMLButtonElement>('.colleague-option');
  for (const option of options) option.click();
  fixture.detectChanges();
  typeDraft(fixture, 'Hello all four people');
  enterMessage(fixture, 'Hello all four people');
  expect(rootElement.querySelector('.review-needed')?.textContent)
    .toContain('Review everyone who will receive this message before sending.');
  expect(api.requests.some(isCreatePost)).toBe(false);

  const dialog = rootElement.querySelector<HTMLDialogElement>('.audience-review');
  if (!dialog) throw new Error('Expected the audience review dialog');
  Object.defineProperty(dialog, 'showModal', {
    configurable: true,
    value: function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); },
  });
  Object.defineProperty(dialog, 'close', {
    configurable: true,
    value: function close(this: HTMLDialogElement): void { this.removeAttribute('open'); },
  });
  rootElement.querySelector<HTMLButtonElement>('.review-audience')?.click();
  rootElement.querySelector<HTMLButtonElement>('.audience-back')?.click();
  enterMessage(fixture, 'Hello all four people');
  await vi.waitFor(() => expect(api.requests.some(isCreatePost)).toBe(true));
  fixture.destroy();
}

it('requires a full audience review before sending to more than three people',
  requiresReviewBeforeSendingToMoreThanThreePeople);

async function keepsPendingGroupRecoveryVisible(): Promise<void> {
  const api = createFetchFixture();
  api.override(function groupSnapshotAndLostReply(request: RequestRecord) {
    if (request.url.startsWith('/api/chat/groups?')) {
      return reply({ rows: [{ groupId: 'sales', name: 'Sales team' }], next: null });
    }
    if (request.url.endsWith('/api/chat/groups/sales')) {
      return reply({ groupId: 'sales', name: 'Sales team', position: 41,
        members: [{ memberId: 'bob', displayName: 'Grace Achieng' },
          { memberId: 'carol', displayName: 'Chris Njeri' }] });
    }
    if (request.method === 'POST' && request.url.endsWith('/messages')) {
      return reply({ status: 'unavailable' }, 503);
    }
    return undefined;
  });
  const fixture = await mount(api);
  const rootElement = root(fixture);
  const groupSelect = rootElement.querySelector<HTMLSelectElement>('#own-group');
  if (!groupSelect) throw new Error('Expected the group selector');
  groupSelect.value = 'sales';
  groupSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await waitForText(fixture, 'Sales team (2 people, as of now)');
  enterMessage(fixture, 'Please keep this message');
  await waitForText(fixture, "couldn't tell whether the message was recorded");
  const changeGroup = rootElement.querySelector<HTMLButtonElement>('.snapshot-title');
  expect(changeGroup?.disabled).toBe(true);
  changeGroup?.click();
  fixture.detectChanges();
  expect(rootElement.querySelector('.composer-dock')).not.toBeNull();
  expect(buttonNamed(fixture, 'Check status').disabled).toBe(false);
  expect(rootElement.textContent).toContain('Sales team (2 people, as of now)');
  fixture.destroy();
}

it('keeps a lost group message recoverable while its reviewed recipients are locked',
  keepsPendingGroupRecoveryVisible);

async function createsGroupFromPeople(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const options = root(fixture).querySelectorAll<HTMLButtonElement>('.colleague-option');
  options[0]?.click();
  options[1]?.click();
  fixture.detectChanges();
  expect(api.requests.some(isCreatePost)).toBe(false);
  enterMessage(fixture, 'Hello everyone');
  function groupWasCreated(): void {
    const create = api.requests.find(isCreatePost);
    expect(create?.body?.['mode']).toBe('group');
  }
  await vi.waitFor(groupWasCreated);
  const create = api.requests.find(isCreatePost);
  expect(create?.body).toMatchObject({ mode: 'group', participantIds: ['alice', 'bob', 'carol'] });
  expect(create?.body?.['colleagueId']).toBeUndefined();
  fixture.destroy();
}

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
  await settle(fixture);
  const panel = root(fixture).querySelector('.draft');
  if (status === 403) {
    expect(root(fixture).textContent).toContain('You no longer have access');
  } else {
    expect(panel?.textContent).toContain('Could not search colleagues. Try again.');
  }
  expect(root(fixture).textContent).not.toContain('No colleagues match');
  expect(root(fixture).querySelectorAll('.colleague-option')).toHaveLength(0);
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
    expect(root(fixture).querySelectorAll('.colleague-option')).toHaveLength(1);
  }
  await vi.waitFor(newerReplyIsShown);
  if (!releaseOlder) throw new Error('Expected the older request');
  releaseOlder(reply({ rows: colleagues, next: null }));
  function nextTask(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root(fixture).querySelectorAll('.colleague-option')).toHaveLength(1);
  expect(root(fixture).textContent).not.toContain('Chris Njeri');
  fixture.destroy();
}
it('ignores an older search reply that arrives after the newer reply', ignoresOlderSearchReply);

function messagePosts(api: ReturnType<typeof createFetchFixture>): RequestRecord[] {
  function isMessagePost(request: RequestRecord): boolean {
    return request.method === 'POST' && request.url.endsWith('/messages');
  }
  return api.requests.filter(isMessagePost);
}

function buttonNamed(fixture: ComponentFixture<DirectChat>, text: string): HTMLButtonElement {
  function hasText(button: HTMLButtonElement): boolean {
    return button.textContent?.trim() === text;
  }
  const buttons = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('button'));
  const button = buttons.find(hasText);
  if (!button) throw new Error(`Expected button ${text}`);
  return button;
}

function typeDraft(fixture: ComponentFixture<DirectChat>, text: string): void {
  const field = messageField(fixture);
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

async function waitForText(fixture: ComponentFixture<DirectChat>, text: string): Promise<void> {
  function showsText(): void {
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain(text);
  }
  await vi.waitFor(showsText);
}

async function openExisting(fixture: ComponentFixture<DirectChat>): Promise<void> {
  root(fixture).querySelector<HTMLButtonElement>('.conversation-row')?.click();
  await waitForText(fixture, 'Is the Tuesday slot still open?');
}

function deferredReply() {
  let release: (response: Response) => void = missingRelease;
  function missingRelease(): void {
    throw new Error('The reply was not held');
  }
  function hold(resolve: (response: Response) => void): void {
    release = resolve;
  }
  const promise = new Promise<Response>(hold);
  return { promise, release };
}

async function keepsFirstSendAndEdits(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Chris Njeri');
  const held = deferredReply();
  function holdFirstSend(request: RequestRecord): Promise<Response> | undefined {
    if (request.method === 'POST' && request.url.endsWith('/messages')) return held.promise;
    return undefined;
  }
  api.override(holdFirstSend);
  enterMessage(fixture, 'First draft');
  function firstPostStarted(): void {
    fixture.detectChanges();
    expect(messagePosts(api)).toHaveLength(1);
  }
  await vi.waitFor(firstPostStarted);
  expect(messageField(fixture).readOnly).toBe(true);
  root(fixture).querySelector<HTMLButtonElement>('.conversation-row')?.click();
  fixture.detectChanges();
  expect(root(fixture).querySelector('.recipient-card')?.textContent).toContain('Chris Njeri');
  const newChat = root(fixture).querySelector<HTMLAnchorElement>('a[href="/workspace/direct"]');
  const navigation = new MouseEvent('click', { bubbles: true, cancelable: true });
  newChat?.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(true);
  expect(root(fixture).querySelector('.conversation-row')?.getAttribute('aria-disabled')).toBe('true');
  // Dispatch directly too: the parent must refuse a second submit even without the child guard.
  const composer = fixture.debugElement.query(By.directive(ChatComposer));
  composer.triggerEventHandler('submitted', 'First draft');
  expect(messagePosts(api)).toHaveLength(1);
  typeDraft(fixture, 'An edit that arrived before the receipt');
  held.release(reply({ status: 'appended', sequence: 2 }));
  await settle(fixture);
  expect(messageField(fixture).value).toBe('An edit that arrived before the receipt');
  fixture.destroy();
}

it('keeps create and first send locked as one change and preserves an edit in the gap', keepsFirstSendAndEdits);

async function retriesApplyingPermissions(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  let reads = 0;
  let posts = 0;
  function permissionsApplying(request: RequestRecord): Response | undefined {
    if (!request.url.includes('/messages')) return undefined;
    if (request.method === 'GET' && ++reads === 1) return reply({ status: 'access_applying' }, 425);
    if (request.method === 'POST' && ++posts === 1) return reply({ status: 'access_applying' }, 425);
    return undefined;
  }
  api.override(permissionsApplying);
  enterMessage(fixture, 'Wait for permissions');
  await waitForText(fixture, 'Starting the conversation');
  expect(messageField(fixture).value).toBe('Wait for permissions');
  expect(messageField(fixture).readOnly).toBe(true);
  function confirmed(): void {
    fixture.detectChanges();
    expect(messageField(fixture).value).toBe('');
  }
  await vi.waitFor(confirmed, { timeout: 4000 });
  expect(posts).toBe(2);
  const attempts = messagePosts(api);
  expect(attempts[0]?.body).toEqual(attempts[1]?.body);
  expect(root(fixture).textContent).not.toContain('no longer have access');
  fixture.destroy();
}

it('keeps the draft through access applying and retries the first read and post', retriesApplyingPermissions);

async function boundsPermissionRetries(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  function keepApplying(request: RequestRecord): Response | undefined {
    if (request.url.includes('/messages')) return reply({ status: 'access_applying' }, 425);
    return undefined;
  }
  api.override(keepApplying);
  vi.useFakeTimers();
  enterMessage(fixture, 'Keep this first message');
  await vi.advanceTimersByTimeAsync(12_000);
  fixture.detectChanges();
  expect(root(fixture).textContent).toContain('Permissions are still being applied');
  expect(messageField(fixture).value).toBe('Keep this first message');
  expect(messageField(fixture).readOnly).toBe(true);
  const count = api.requests.length;
  await vi.advanceTimersByTimeAsync(12_000);
  expect(api.requests).toHaveLength(count);
  vi.useRealTimers();
  fixture.destroy();
}

it('bounds access applying retries and keeps a retryable first message', boundsPermissionRetries);

async function retriesMissingCreate(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  let loseCreate = true;
  function missingCreate(request: RequestRecord): Response | undefined {
    if (request.url === '/api/conversations' && request.method === 'POST' && loseCreate) {
      loseCreate = false;
      throw new TypeError('Request did not reach the server');
    }
    if (request.url.includes('/changes/')) return reply({ status: 'refused' }, 403);
    return undefined;
  }
  api.override(missingCreate);
  enterMessage(fixture, 'Please keep this');
  await waitForText(fixture, "couldn't tell whether the conversation started");
  buttonNamed(fixture, 'Check status').click();
  await waitForText(fixture, 'The chat was not created');
  expect(messageField(fixture).value).toBe('Please keep this');
  expect(root(fixture).textContent).not.toContain('access changed');
  buttonNamed(fixture, 'Try again').click();
  await settle(fixture);
  function isCreation(request: RequestRecord): boolean {
    return request.url === '/api/conversations' && request.method === 'POST';
  }
  const creations = api.requests.filter(isCreation);
  expect(creations).toHaveLength(2);
  expect(creations[0]?.body).toEqual(creations[1]?.body);
  fixture.destroy();
}

it('says a lost create was not created on a 403 check and retries the same ids', retriesMissingCreate);

async function retriesMissingMessage(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  let loseSend = true;
  function missingMessage(request: RequestRecord): Response | undefined {
    if (request.method === 'POST' && request.url.endsWith('/messages') && loseSend) {
      loseSend = false;
      return reply({ status: 'unavailable' }, 503);
    }
    if (request.url.includes('/changes/')) return reply({ status: 'not_found' }, 404);
    return undefined;
  }
  api.override(missingMessage);
  enterMessage(fixture, 'Not received yet');
  await waitForText(fixture, "couldn't tell whether the message was recorded");
  buttonNamed(fixture, 'Check status').click();
  await waitForText(fixture, 'No record of this message yet. It may still arrive.');
  expect(messageField(fixture).value).toBe('Not received yet');
  buttonNamed(fixture, 'Send again').click();
  await settle(fixture);
  const sends = messagePosts(api);
  expect(sends).toHaveLength(2);
  expect(sends[0]?.body).toEqual(sends[1]?.body);
  fixture.destroy();
}

it('offers a same-command resend after a 503 and a missing message status', retriesMissingMessage);

async function keepsRefusedDraft(status: number): Promise<void> {
    const api = createFetchFixture();
    const fixture = await mount(api);
    await openExisting(fixture);
    function refuseMessage(request: RequestRecord): Response | undefined {
      if (request.method === 'POST') return reply({ status: 'refused' }, status);
      return undefined;
    }
    api.override(refuseMessage);
    enterMessage(fixture, 'A private draft');
    await settle(fixture);
    expect(messageField(fixture).value).toBe('A private draft');
    const failure = root(fixture).querySelector('.send-feedback');
    const failureText = failure?.textContent;
    expect(failureText).toBeTruthy();
    buttonNamed(fixture, 'Refresh').click();
    await settle(fixture);
    expect(root(fixture).querySelector('.send-feedback')?.textContent).toBe(failureText);
    typeDraft(fixture, 'Corrected private draft');
    expect(root(fixture).querySelector('.send-feedback')?.textContent).not.toContain(failureText);
    fixture.destroy();
  }

it.each([400, 409])('keeps typed text after a %i send and keeps its failure through refresh',
  keepsRefusedDraft);

async function purgesProtectedContentAfterRefusedGroupSend(): Promise<void> {
  const api = createFetchFixture();
  api.addGroupConversation();
  const fixture = await mount(api);
  const groupRow = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('.conversation-row'))
    .find((row) => row.textContent?.includes('Chris Njeri'));
  groupRow?.click();
  await settle(fixture);
  typeDraft(fixture, 'Protected group draft');
  function refusePost(request: RequestRecord): Response | undefined {
    if (request.method === 'POST') return reply({ status: 'refused' }, 403);
    return undefined;
  }
  api.override(refusePost);
  enterMessage(fixture, 'Protected group draft');
  await settle(fixture);
  expect(root(fixture).querySelector('h1')?.textContent).toContain('Unavailable');
  expect(root(fixture).textContent).not.toContain('Hello everyone');
  expect(root(fixture).textContent).not.toContain('Chris Njeri');
  expect(root(fixture).querySelector('oc-chat-composer')).toBeNull();
  fixture.destroy();
}

it('purges protected content after a refused group message post',
  purgesProtectedContentAfterRefusedGroupSend);

async function retainsConversationNames(): Promise<void> {
  const fixture = await mount();
  const field = searchField(fixture);
  field.value = 'Chris';
  field.dispatchEvent(new Event('input'));
  await settle(fixture);
  expect(root(fixture).querySelector('.conversation-row')?.textContent).toContain('Grace Achieng');
  fixture.destroy();
}

it('keeps conversation names when a different colleague is searched', retainsConversationNames);

async function ignoresLateHistory(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const held = deferredReply();
  function holdHistory(request: RequestRecord): Promise<Response> | undefined {
    if (request.method === 'GET' && request.url.includes('/existing/messages')) return held.promise;
    return undefined;
  }
  api.override(holdHistory);
  root(fixture).querySelector<HTMLButtonElement>('.conversation-row')?.click();
  fixture.detectChanges();
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  await chooseColleague(fixture, 'Chris Njeri');
  held.release(reply({ rows: [eventRow(1, 'bob', 'Grace private history')], position: 1,
    generation: 1, computerState: 'not_applicable' }));
  await settle(fixture);
  expect(root(fixture).textContent).not.toContain('Grace private history');
  expect(api.sockets).toHaveLength(0);
  fixture.destroy();
}

it('does not paint late history under a new recipient', ignoresLateHistory);

async function distinguishesHistoryStates(): Promise<void> {
    const api = createFetchFixture();
    const fixture = await mount(api);
    const held = deferredReply();
    function holdHistory(request: RequestRecord): Promise<Response> | undefined {
      if (request.url.includes('/messages')) return held.promise;
      return undefined;
    }
    api.override(holdHistory);
    root(fixture).querySelector<HTMLButtonElement>('.conversation-row')?.click();
    fixture.detectChanges();
    expect(root(fixture).textContent).toContain('Loading messages');
    expect(root(fixture).textContent).not.toContain('No messages yet');
    held.release(reply({}, 503));
    await settle(fixture);
    expect(root(fixture).textContent).toContain('Messages could not be loaded');
    expect(root(fixture).textContent).not.toContain('No messages yet');
    fixture.destroy();
  }

it('shows a loading history rather than an empty transcript and a failure rather than no messages',
  distinguishesHistoryStates);

async function keepsRefreshFocus(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  function unavailableList(request: RequestRecord): Response | undefined {
    if (request.url === '/api/conversations') return reply({}, 503);
    return undefined;
  }
  api.override(unavailableList);
  buttonNamed(fixture, 'Refresh').click();
  await settle(fixture);
  const refresh = root(fixture).querySelector<HTMLButtonElement>('.refresh-error button');
  if (!refresh) throw new Error('Expected refresh banner');
  const held = deferredReply();
  function holdList(request: RequestRecord): Promise<Response> | undefined {
    if (request.url === '/api/conversations') return held.promise;
    return undefined;
  }
  api.override(holdList);
  refresh.focus();
  refresh.click();
  fixture.detectChanges();
  expect(document.activeElement).toBe(refresh);
  expect(refresh.getAttribute('aria-disabled')).toBe('true');
  held.release(reply({}, 503));
  await settle(fixture);
  expect(document.activeElement).toBe(refresh);
  fixture.destroy();
}

it('keeps refresh-banner focus until the result is known', keepsRefreshFocus);

async function keepsFirstRetryFocus(): Promise<void> {
  const api = createFetchFixture();
  function failList(request: RequestRecord): Response | undefined {
    if (request.url === '/api/conversations') return reply({}, 503);
    return undefined;
  }
  api.override(failList);
  const fixture = await mountWithoutReady(api);
  await waitForText(fixture, 'Try again');
  expect(root(fixture).textContent).not.toContain('No direct conversations yet');
  const retry = buttonNamed(fixture, 'Try again');
  const held = deferredReply();
  function holdContext(request: RequestRecord): Promise<Response> | undefined {
    if (request.url === '/api/chat') return held.promise;
    return undefined;
  }
  api.override(holdContext);
  retry.focus();
  retry.click();
  fixture.detectChanges();
  expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute('aria-disabled')).toBe('true');
  held.release(reply({}, 503));
  await settle(fixture);
  expect(document.activeElement).toBe(retry);
  fixture.destroy();
}

it('keeps first-load retry focus and avoids false empty-list messages', keepsFirstRetryFocus);

async function showsUnavailableForMissingRequestedConversation(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mountWithoutReady(api, 'removed-group');
  await waitForText(fixture, 'Conversation not found or unavailable');
  expect(root(fixture).querySelector('h1')?.textContent).toContain('Unavailable');
  expect(root(fixture).textContent).not.toContain('You no longer have access');
  expect(root(fixture).textContent).not.toContain('Loading direct conversations');
  const availableConversation = root(fixture).querySelector<HTMLButtonElement>(
    '.rail .conversation-row',
  );
  expect(availableConversation?.textContent).toContain('Grace Achieng');
  expect(availableConversation).not.toBeNull();
  expect(root(fixture).querySelector('textarea')).toBeNull();
  expect(api.sockets).toHaveLength(0);

  availableConversation?.click();
  await waitForText(fixture, 'Is the Tuesday slot still open?');
  expect(root(fixture).textContent).not.toContain('Conversation not found or unavailable');
  expect(root(fixture).querySelector('textarea')).not.toBeNull();
  fixture.destroy();
}

it('shows an unavailable state for a missing requested conversation',
  showsUnavailableForMissingRequestedConversation);

async function clearsAfterRealRefusal(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  typeDraft(fixture, 'Private text');
  const held = deferredReply();
  function holdList(request: RequestRecord): Promise<Response> | undefined {
    if (request.url === '/api/conversations') return held.promise;
    return undefined;
  }
  api.override(holdList);
  buttonNamed(fixture, 'Refresh').click();
  await Promise.resolve();
  const socket = api.sockets.at(-1);
  const refused = { version: 1, topic: 'conversation', type: 'refused',
    conversationId: 'existing', position: 2, generation: 1 };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(refused) }));
  fixture.detectChanges();
  held.release(reply({ rows: [conversation('existing', 'bob')] }));
  await settle(fixture);
  expect(root(fixture).textContent).toContain('You no longer have access');
  expect(root(fixture).textContent).not.toContain('Grace Achieng');
  expect(root(fixture).querySelector('textarea')).toBeNull();
  expect(root(fixture).querySelectorAll('article.message, .conversation-row')).toHaveLength(0);
  expect(api.closedSockets).toContain(socket);
  fixture.destroy();
}

it('clears protected data and ignores a held refresh after real access loss', clearsAfterRealRefusal);

async function focusesUnavailableNoticeAfterPhoneMenuRevocation(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  const dialog = root(fixture).querySelector<HTMLDialogElement>('oc-navigation-menu dialog');
  if (!dialog) throw new Error('Expected the phone navigation dialog');
  const navigationDialog = dialog;
  function showNavigation(): void {
    navigationDialog.setAttribute('open', '');
  }
  function closeNavigation(): void {
    navigationDialog.removeAttribute('open');
  }
  Object.defineProperty(dialog, 'showModal', { configurable: true, value: showNavigation });
  Object.defineProperty(dialog, 'close', { configurable: true, value: closeNavigation });
  const opener = root(fixture).querySelector<HTMLButtonElement>('.navigation-toggle');
  opener?.click();
  await settle(fixture);
  expect(root(fixture).querySelector('oc-navigation-menu dialog')?.hasAttribute('open')).toBe(true);
  const socket = api.sockets.at(-1);
  const refused = { version: 1, topic: 'conversation', type: 'refused',
    conversationId: 'existing', position: 2, generation: 1 };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(refused) }));
  await settle(fixture);
  await settleAnimationFrames();
  const unavailableHeading = root(fixture).querySelector('h1');
  expect(root(fixture).querySelector('oc-navigation-menu dialog')?.hasAttribute('open')).toBe(false);
  expect(document.activeElement).toBe(unavailableHeading);
  fixture.destroy();
}

it('focuses the unavailable notice after phone-menu revocation',
  focusesUnavailableNoticeAfterPhoneMenuRevocation);

async function restoresSearchFocus(): Promise<void> {
  const fixture = await mount();
  await chooseColleague(fixture, 'Grace Achieng');
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  function searchHasFocus(): void {
    expect(document.activeElement).toBe(searchField(fixture));
  }
  await vi.waitFor(searchHasFocus);
  fixture.destroy();
}

it('returns focus to colleague search when the selected person is changed', restoresSearchFocus);

async function announcesMessageReceipts(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  const socket = api.sockets.at(-1);
  const incoming = { version: 1, topic: 'conversation', type: 'event', conversationId: 'existing',
    position: 3, generation: 1, row: eventRow(3, 'bob', 'New reply') };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(incoming) }));
  fixture.detectChanges();
  expect(root(fixture).querySelector('[role="status"]')?.textContent)
    .toContain('New message from Grace Achieng');
  function failHistory(request: RequestRecord): Response | undefined {
    if (request.method === 'GET' && request.url.includes('/messages')) return reply({}, 503);
    return undefined;
  }
  api.override(failHistory);
  enterMessage(fixture, 'Confirmed message');
  await settle(fixture);
  expect(root(fixture).textContent).toContain('Saved.');
  expect(root(fixture).querySelector('[role="status"]')?.textContent).toContain('Saved.');
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
}

it('announces received messages and preserves the recorded receipt when history fails', announcesMessageReceipts);

async function opensGroupTranscriptWithRecordedAuthors(): Promise<void> {
  const api = createFetchFixture();
  api.addGroupConversation();
  const fixture = await mount(api);
  const groupRow = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('.conversation-row'))
    .find((row) => row.textContent?.includes('Chris Njeri'));
  expect(groupRow).toBeDefined();
  groupRow?.click();
  await settle(fixture);
  const screen = root(fixture);
  expect(screen.textContent).toContain('Hello everyone');
  expect(screen.textContent).toContain('Chris Njeri');
  expect(screen.textContent).toContain('@agent is just text');
  expect(screen.querySelector('[aria-label="Stop"]')).toBeNull();
  expect(screen.textContent).not.toContain('Delivered');
  enterMessage(fixture, '@agent stays text');
  messageField(fixture).dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true,
  }));
  await settle(fixture);
  const groupSends = api.requests.filter((request) => request.method === 'POST'
    && request.url.endsWith('/messages'));
  expect(groupSends).toHaveLength(1);
  expect(typeof groupSends[0]?.body?.['id']).toBe('string');
  expect(groupSends[0]?.body?.['text']).toBe('@agent stays text');
  expect(root(fixture).textContent).toContain('Saved');
  fixture.destroy();
}

it('opens group history with each stored human author and no assistant controls',
  opensGroupTranscriptWithRecordedAuthors);

async function followsNewestMessages(): Promise<void> {
  const api = createFetchFixture();
  api.seedExistingHistory(40);
  const fixture = await mount(api);
  const transcript = root(fixture).querySelector<HTMLElement>('.transcript');
  if (!transcript) throw new Error('Expected transcript');
  Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1500 });
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 200 });
  await openExisting(fixture);
  function scrolledToEnd(): void {
    expect(transcript?.scrollTop).toBe(1500);
  }
  await vi.waitFor(scrolledToEnd);
  transcript.scrollTop = 100;
  transcript.dispatchEvent(new Event('scroll'));
  const socket = api.sockets.at(-1);
  const incoming = { version: 1, topic: 'conversation', type: 'event', conversationId: 'existing',
    position: 41, generation: 1, row: eventRow(41, 'bob', 'New reply below') };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(incoming) }));
  await settle(fixture);
  await settleAnimationFrames();
  expect(transcript.scrollTop).toBe(100);
  fixture.destroy();
}

it('scrolls loaded and new messages to the end unless the person has scrolled up', followsNewestMessages);

async function keepsSeparateDrafts(): Promise<void> {
  const fixture = await mount();
  await openExisting(fixture);
  typeDraft(fixture, 'Only for Grace');
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  await chooseColleague(fixture, 'Chris Njeri');
  expect(messageField(fixture).value).toBe('');
  await openExisting(fixture);
  expect(messageField(fixture).value).toBe('Only for Grace');
  fixture.destroy();
}

it('keeps separate drafts for a conversation and a new recipient', keepsSeparateDrafts);

async function keepsDraftsWithTheirGroupConversation(): Promise<void> {
  const api = createFetchFixture();
  api.addGroupConversation();
  const fixture = await mount(api);
  await openExisting(fixture);
  typeDraft(fixture, 'Private direct note');
  const groupRow = Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('.conversation-row'))
    .find((row) => row.textContent?.includes('Chris Njeri'));
  groupRow?.click();
  await settle(fixture);
  expect(messageField(fixture).value).toBe('');
  typeDraft(fixture, 'Group-only note');
  await openExisting(fixture);
  expect(messageField(fixture).value).toBe('Private direct note');
  const reopenedGroup = Array.from(
    root(fixture).querySelectorAll<HTMLButtonElement>('.conversation-row'),
  ).find((row) => row.textContent?.includes('Chris Njeri'));
  reopenedGroup?.click();
  await settle(fixture);
  expect(messageField(fixture).value).toBe('Group-only note');
  fixture.destroy();
}

it('keeps each draft with its direct or group conversation', keepsDraftsWithTheirGroupConversation);

async function refreshesCurrentSearch(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  function failSearch(request: RequestRecord): Response | undefined {
    if (request.url.includes('/colleagues')) return reply({}, 503);
    return undefined;
  }
  api.override(failSearch);
  const field = searchField(fixture);
  field.value = 'Nobody';
  field.dispatchEvent(new Event('input'));
  await settle(fixture);
  expect(root(fixture).textContent).toContain('Could not search colleagues. Try again.');
  expect(root(fixture).textContent).not.toContain('No colleagues match');
  expect(root(fixture).querySelectorAll('.colleague-option')).toHaveLength(0);
  api.clearOverride();
  field.value = 'Chris';
  field.dispatchEvent(new Event('input'));
  await settle(fixture);
  buttonNamed(fixture, 'Refresh').click();
  await settle(fixture);
  expect(searchField(fixture).value).toBe('Chris');
  const options = root(fixture).querySelector('.colleague-options');
  expect(options?.textContent).toContain('Chris Njeri');
  expect(options?.textContent).not.toContain('Grace Achieng');
  fixture.destroy();
}

it('shows search failures honestly and refreshes the typed query', refreshesCurrentSearch);

function assertOnlyHumanRequests(api: ReturnType<typeof createFetchFixture>): void {
  const anyString: unknown = expect.any(String);
  const anyNumber: unknown = expect.any(Number);
  expect(api.requestCounts.turns).toBe(0);
  expect(api.requestCounts.models).toBe(0);
  for (const request of api.requests) {
    const pathname = new URL(request.url, location.origin).pathname;
    const allowed = pathname === '/api/chat' || pathname === '/api/chat/colleagues'
      || pathname === '/api/chat/groups'
      || pathname === '/api/conversations'
      || /^\/api\/conversations\/[\w-]+\/(messages|changes\/[\w-]+)$/.test(pathname);
    expect(allowed, `Unexpected direct-chat request: ${pathname}`).toBe(true);
    if (request.method !== 'POST') continue;
    if (pathname === '/api/conversations') {
      expect(request.body).toEqual({ id: anyString, conversationId: anyString,
        mode: 'direct', colleagueId: anyString });
    } else {
      expect(request.body).toEqual({ id: anyString, text: anyString });
    }
  }
  for (const raw of api.sentSocketMessages) {
    const sent: unknown = JSON.parse(raw);
    expect(sent).toEqual({ type: 'subscribe', topic: 'conversation',
      conversationId: anyString, since: anyNumber, generation: anyNumber });
  }
}

async function sendsHumanRequestsOnly(): Promise<void> {
    const api = createFetchFixture();
    const fixture = await mount(api);
    await chooseColleague(fixture, 'Grace Achieng');
    enterMessage(fixture, 'Ordinary text @agent');
    await settle(fixture);
    assertOnlyHumanRequests(api);
    expect(root(fixture).querySelector('#attach-toggle')).toBeNull();
    expect(root(fixture).textContent).not.toContain('Agent session');
    expect(root(fixture).textContent).not.toContain('Message your agent');
    expect(root(fixture).querySelector('[aria-label="Stop"]')).toBeNull();
    fixture.destroy();
  }

it('counts zero turn and model requests on the real API paths and shows only direct controls',
  sendsHumanRequestsOnly);

async function detectsRealAiRequests(): Promise<void> {
  const api = createFetchFixture();
  const turn = { method: 'POST', body: JSON.stringify({ id: 'turn', text: 'AI request',
    executionMode: 'restricted' }) };
  await fetch('/api/conversations/existing/messages', turn);
  const model = { method: 'POST', body: JSON.stringify({ model: 'test', input: 'AI request' }) };
  await fetch('/v1/responses', model);
  expect(api.requestCounts).toEqual({ turns: 1, models: 1 });
  function mustRefuseAi(): void {
    assertOnlyHumanRequests(api);
  }
  expect(mustRefuseAi).toThrow();
}

it('detects a turn on the messages path and a model call on the responses path', detectsRealAiRequests);

async function ignoresLateDirectoryReply(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const held = deferredReply();
  function holdOlderSearch(request: RequestRecord): Promise<Response> | undefined {
    if (request.url.includes('q=g&')) return held.promise;
    return undefined;
  }
  api.override(holdOlderSearch);
  const field = searchField(fixture);
  field.value = 'g';
  field.dispatchEvent(new Event('input'));
  field.value = 'Grace';
  field.dispatchEvent(new Event('input'));
  await waitForText(fixture, 'Grace Achieng');
  held.release(reply({ rows: colleagues, next: null }));
  function nextTask(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  await settle(fixture);
  expect(root(fixture).querySelectorAll('.colleague-option')).toHaveLength(1);
  fixture.destroy();
}

it('ignores older recipient results while the query changes', ignoresLateDirectoryReply);

async function locksAfterCreateReceipt(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  const held = deferredReply();
  let firstRead = true;
  function holdFirstRead(request: RequestRecord): Promise<Response> | undefined {
    if (request.method === 'GET' && request.url.includes('/messages') && firstRead) {
      firstRead = false;
      return held.promise;
    }
    return undefined;
  }
  api.override(holdFirstRead);
  enterMessage(fixture, 'First message once');
  function createConfirmed(): void {
    fixture.detectChanges();
    expect(firstRead).toBe(false);
  }
  await vi.waitFor(createConfirmed);
  expect(messageField(fixture).readOnly).toBe(true);
  messageField(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const composer = fixture.debugElement.query(By.directive(ChatComposer));
  composer.triggerEventHandler('submitted', 'First message once');
  expect(messagePosts(api)).toHaveLength(0);
  held.release(reply({ rows: [], position: 0, generation: 1, computerState: 'not_applicable' }));
  await settle(fixture);
  expect(messagePosts(api)).toHaveLength(1);
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
}

it('keeps the composer locked after create while the first permission read is held', locksAfterCreateReceipt);

function fixedRandom(): number {
    return 0;
  }

function isPost(request: RequestRecord): boolean {
    return request.method === 'POST';
  }

function isListRead(request: RequestRecord): boolean {
  const path = new URL(request.url, location.origin).pathname;
  return request.method === 'GET' && path === '/api/conversations';
}

function isCreatePost(request: RequestRecord): boolean {
  return request.method === 'POST' && request.url.endsWith('/conversations');
}

function requestText(request: RequestRecord): unknown {
    return request.body?.['text'];
  }

function requestId(request: RequestRecord): unknown {
    return request.body?.['id'];
  }

async function waitForEmptyDraft(fixture: ComponentFixture<DirectChat>): Promise<void> {
  function isEmpty(): void {
    fixture.detectChanges();
    expect(messageField(fixture).value).toBe('');
  }
  await vi.waitFor(isEmpty);
}

async function checksPermissionsWithoutPosting(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  let applying = true;
  function waitForPermissions(request: RequestRecord): Response | undefined {
    if (applying && request.url.includes('/messages')) {
      return reply({ status: 'access_applying' }, 425);
    }
    return undefined;
  }
  api.override(waitForPermissions);
  vi.useFakeTimers();
  enterMessage(fixture, 'Keep the first message');
  await vi.advanceTimersByTimeAsync(12_000);
  fixture.detectChanges();
  applying = false;
  buttonNamed(fixture, 'Check status').click();
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
  expect(messagePosts(api)).toHaveLength(0);
  expect(messageField(fixture).value).toBe('Keep the first message');
  expect(root(fixture).textContent).toContain('Permissions are ready');
  buttonNamed(fixture, 'Send again').click();
  await vi.advanceTimersByTimeAsync(0);
  fixture.detectChanges();
  expect(messagePosts(api)).toHaveLength(1);
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
}

it('checks ready permissions without posting until Send again is chosen',
  checksPermissionsWithoutPosting);

async function restoresFocusAfterRefresh(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  function failList(request: RequestRecord): Response | undefined {
    if (isListRead(request)) return reply({}, 503);
    return undefined;
  }
  api.override(failList);
  buttonNamed(fixture, 'Refresh').click();
  await settle(fixture);
  const refresh = root(fixture).querySelector<HTMLButtonElement>('.refresh-error button');
  if (!refresh) throw new Error('Expected refresh banner');
  api.clearOverride();
  refresh.focus();
  refresh.click();
  await settle(fixture);
  function composerHasFocus(): void {
    expect(document.activeElement).toBe(messageField(fixture));
  }
  await vi.waitFor(composerHasFocus);
  fixture.destroy();
}

it('restores focus to the composer after a successful banner refresh', restoresFocusAfterRefresh);

async function keepsDraftWhenPermissionReadFails(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await chooseColleague(fixture, 'Grace Achieng');
  function failRead(request: RequestRecord): Response | undefined {
    if (request.method === 'GET' && request.url.includes('/messages')) return reply({}, 503);
    return undefined;
  }
  api.override(failRead);
  enterMessage(fixture, 'Keep this unsent message');
  await settle(fixture);
  expect(root(fixture).textContent).toContain('Could not check the new chat');
  expect(root(fixture).textContent).not.toContain('Permissions are still being applied');
  expect(messagePosts(api)).toHaveLength(0);
  expect(messageField(fixture).value).toBe('Keep this unsent message');
  fixture.destroy();
}

it('keeps an unsent draft after an unavailable permission read without claiming a delay',
  keepsDraftWhenPermissionReadFails);

async function waitsForFontsBeforeScrolling(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  const transcript = root(fixture).querySelector<HTMLElement>('.transcript');
  if (!transcript) throw new Error('Expected transcript');
  const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  let finishFonts: () => void = missingFonts;
  function missingFonts(): void {
    throw new Error('Expected pending fonts');
  }
  function holdFonts(resolve: () => void): void {
    finishFonts = resolve;
  }
  const ready = new Promise<void>(holdFonts);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
  Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1500 });
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 200 });
  try {
    await openExisting(fixture);
    function waitForFrame(resolve: () => void): void {
      requestAnimationFrame(resolve);
    }
    await new Promise<void>(waitForFrame);
    expect(transcript.scrollTop).toBe(0);
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 2000 });
    finishFonts();
    function scrolledAfterFonts(): void {
      expect(transcript?.scrollTop).toBe(2000);
    }
    await vi.waitFor(scrolledAfterFonts);
  } finally {
    finishFonts();
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
    else Reflect.deleteProperty(document, 'fonts');
    fixture.destroy();
  }
}

it('waits for the fonts before scrolling the loaded transcript to the newest message',
  waitsForFontsBeforeScrolling);

async function settleAnimationFrames(): Promise<void> {
  function waitForFrame(resolve: () => void): void {
    requestAnimationFrame(resolve);
  }
  await new Promise<void>(waitForFrame);
  await new Promise<void>(waitForFrame);
}

async function doesNotAnnounceOtherEvents(): Promise<void> {
  const api = createFetchFixture();
  const fixture = await mount(api);
  await openExisting(fixture);
  const before = root(fixture).querySelector('[role="status"]')?.textContent;
  const row = { id: 'closed', position: 3, type: 'conversation.closed',
    time: '2026-10-06T09:00:00Z', data: { closedBy: 'bob' } };
  const incoming = { version: 1, topic: 'conversation', type: 'event', conversationId: 'existing',
    position: 3, generation: 1, row };
  const socket = api.sockets.at(-1);
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(incoming) }));
  await settle(fixture);
  expect(root(fixture).querySelector('[role="status"]')?.textContent).toBe(before);
  expect(root(fixture).textContent).not.toContain('New message from');
  fixture.destroy();
}

it('does not announce a non-message event as a received message', doesNotAnnounceOtherEvents);

async function movesRecipientDraftIntoCreatedChat(): Promise<void> {
  const fixture = await mount();
  await chooseColleague(fixture, 'Grace Achieng');
  typeDraft(fixture, 'First chat draft');
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  await chooseColleague(fixture, 'Grace Achieng');
  expect(messageField(fixture).value).toBe('First chat draft');
  enterMessage(fixture, 'First chat draft');
  await waitForEmptyDraft(fixture);
  await settle(fixture);
  root(fixture).querySelector<HTMLButtonElement>('.change-recipient')?.click();
  fixture.detectChanges();
  await chooseColleague(fixture, 'Grace Achieng');
  expect(messageField(fixture).value).toBe('');
  fixture.destroy();
}

it('does not restore a sent recipient draft when starting another chat with the same person',
  movesRecipientDraftIntoCreatedChat);
