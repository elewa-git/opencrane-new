import { z } from 'zod';
import type { ChatRow } from '@opencrane/protocol';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Workspace } from './workspace';
import { ChatComposer } from './composer';
import { RANDOM_SOURCE, SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

interface CaptureWorkspace {
  fixture: ComponentFixture<Workspace>;
  root: HTMLElement;
  calls: string[];
  postBodies: unknown[];
  socket: SocketLike;
  setReply(status: number): void;
  denyFeedRead(): void;
  setMessageStatus(status: number): void;
  confirmPendingMessage(): void;
  rows: Record<string, unknown>[];
}

async function createCaptureWorkspace(
  initialRows: Record<string, unknown>[] = [],
  approvalCards: Record<string, unknown>[] | ((path: string) => Record<string, unknown>[]) = [],
  assistantKind?: 'team',
  computerState = 'ready',
): Promise<CaptureWorkspace> {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const rows = [...initialRows];
  const calls: string[] = [];
  const postBodies: unknown[] = [];
  let replyStatus = 201;
  let denyMessages = false;
  let messageStatus = 200;
  let messageRecorded = false;
  const initialConversation = { conversationId: 'chat', assistantId: 'assistant', assistantKind,
    payingGroupId: assistantKind === 'team' ? 'opaque-sales' : undefined,
    createdBy: 'me', createdAt: '2026-10-03T10:00:00Z', status: 'open', mode: 'agent_session' };
  const conversations = [initialConversation];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    const pathname = new URL(path, location.origin).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST' && typeof init.body === 'string') {
      postBodies.push(JSON.parse(init.body));
    }
    if (pathname === '/auth/me') {
      return Promise.resolve(new Response('{"authenticated":true,"user":{"name":"Alex"}}'));
    }
    if (pathname === '/api/chat') {
      return Promise.resolve(new Response('{"memberId":"me","assistantId":"assistant"}'));
    }
    if (pathname.endsWith('/approvals')) {
      const currentCards = typeof approvalCards === 'function'
        ? approvalCards(path)
        : approvalCards;
      return Promise.resolve(new Response(JSON.stringify({ cards: currentCards, csrf: 'fixture' })));
    }
    if (pathname === '/api/conversations' && init?.method !== 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ rows: conversations })));
    }
    if (pathname === '/api/conversations' && init?.method === 'POST'
      && typeof init.body === 'string') {
      const command = z.object({ conversationId: z.string() }).parse(JSON.parse(init.body));
      const conversation = { ...initialConversation, conversationId: command.conversationId };
      conversations.push(conversation);
      return Promise.resolve(new Response('{"status":"appended","sequence":1}'));
    }
    if (pathname.endsWith('/screenshots')) {
      if (replyStatus === 0) return Promise.reject(new TypeError('Network lost'));
      if (replyStatus === 201 && !rows.some(row => row['type'] === 'file.uploaded')) {
        rows.push(screenshotRow(rows.length + 1));
      }
      if (replyStatus === 422) rows.push(rejectedRow(rows.length + 1));
      const body = replyStatus === 201
        ? { status: 'appended', fileId: 'screen' }
        : replyStatus === 422 ? { status: 'infected', fileId: 'rejected-screen' } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: replyStatus }));
    }
    if (pathname.includes('/changes/')) {
      if (messageRecorded) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'appended',
          commandId: pathname.split('/').at(-1) })));
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
    if (pathname.endsWith('/messages')) {
      if (denyMessages) return Promise.resolve(new Response('{}', { status: 403 }));
      if (messageStatus === 0) return Promise.reject(new TypeError('Network lost'));
      if (messageStatus !== 200) {
        return Promise.resolve(new Response('{}', { status: messageStatus }));
      }
      const since = Number(new URL(path, location.origin).searchParams.get('since') ?? 0);
      const visibleRows = rows.filter(row => Number(row['position']) > since);
      return Promise.resolve(new Response(JSON.stringify({ rows: visibleRows,
        position: rows.length, generation: 1, computerState })));
    }
    if (pathname.endsWith('/files/view')) {
      return Promise.resolve(new Response('<svg/>', {
        headers: { 'content-type': 'image/svg+xml' },
      }));
    }
    return Promise.resolve(new Response('{}'));
  });
  const socket: SocketLike = {
    readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
    send: vi.fn(), close: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: SOCKET_FACTORY, useValue: () => socket },
    { provide: RANDOM_SOURCE, useValue: () => 0 },
  ] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  await vi.waitFor(() => expect(fixture.componentInstance['chat'].selected()).toBe('chat'));
  await vi.waitFor(() => expect(fixture.componentInstance['chat'].loading()).toBe(false));
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing workspace root');
  return {
    fixture, root, calls, postBodies, rows, socket,
    setReply(status) { replyStatus = status; },
    denyFeedRead() { denyMessages = true; },
    confirmPendingMessage() { messageRecorded = true; },
    setMessageStatus(status) { messageStatus = status; },
  };
}

function screenshotRow(position: number): Record<string, unknown> {
  return { id: `screen-${position}`, position, type: 'file.uploaded',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'screen', uploadedBy: 'me', name: 'screen.png',
      size: 421888, mime: 'image/png', screenshot: {
        computerId: 'computer', generation: 4, capturedAt: '2026-10-02T10:42:00Z',
        width: 1440, height: 900,
      },
    } };
}

function rejectedRow(position: number): Record<string, unknown> {
  return { id: `rejected-${position}`, position, type: 'file.rejected',
    time: '2026-10-02T10:42:00Z', data: {
      conversationId: 'chat', fileId: 'rejected-screen', uploadedBy: 'me',
      name: 'screen.png', size: 421888, sha256: 'hash', reason: 'infected',
      screenshot: { computerId: 'computer', generation: 4,
        capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
    } };
}

function openPanelDialog(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closePanelDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

function politeStatusText(root: HTMLElement): string {
  const statuses = root.querySelectorAll('[role="status"][aria-live="polite"]');
  const messages: string[] = [];
  for (const status of statuses) messages.push(status.textContent ?? '');
  return messages.join(' ');
}

interface DownloadScenario {
  name: string;
  expectedVisible: boolean;
  rows: object[];
}

async function checkDownloadVisibility(scenario: DownloadScenario): Promise<void> {
  history.replaceState({}, '', '/workspace?conversation=chat');
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const path = input instanceof Request ? input.url : String(input);
    const pathname = new URL(path, location.origin).pathname;
    let body: object;
    if (pathname === '/auth/me') {
      body = { authenticated: true, user: { name: 'Alex' } };
    } else if (pathname === '/api/chat') {
      body = { memberId: 'me', assistantId: 'assistant' };
    } else if (pathname.endsWith('/approvals')) {
      body = { cards: [], csrf: 'fixture' };
    } else if (pathname === '/api/conversations') {
      body = { rows: [{
        conversationId: 'chat', assistantId: 'assistant', createdBy: 'me',
        createdAt: '2026-10-03T10:00:00Z', status: 'open',
      }] };
    } else {
      body = {
        rows: scenario.rows,
        position: scenario.rows.length,
        generation: 1,
        computerState: 'ready',
      };
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  });

  const socket: SocketLike = {
    readyState: 1, onopen: null, onclose: null, onerror: null,
    onmessage: null, send: vi.fn(), close: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No workspace root');
  await vi.waitFor(() => expect(root.querySelector('.file-card')).not.toBeNull());
  const download = root.querySelector('.file-card a');
  expect(download !== null).toBe(scenario.expectedVisible);
  fixture.destroy();
}

const downloadScenarios: DownloadScenario[] = [
  {
    name: 'your own upload',
    expectedVisible: true,
    rows: [{
      id: 'upload', position: 1, type: 'file.uploaded', time: '2026-10-03T10:00:00Z',
      data: {
        conversationId: 'chat', fileId: 'file', uploadedBy: 'me',
        name: 'brief.pdf', size: 1024, mime: 'application/pdf',
      },
    }],
  },
  {
    name: 'another member’s ordinary upload',
    expectedVisible: false,
    rows: [{
      id: 'upload', position: 1, type: 'file.uploaded', time: '2026-10-03T10:00:00Z',
      data: {
        conversationId: 'chat', fileId: 'file', uploadedBy: 'someone-else',
        name: 'brief.pdf', size: 1024, mime: 'application/pdf',
      },
    }],
  },
  {
    name: 'an assistant file',
    expectedVisible: false,
    rows: [
      {
        id: 'message', position: 1, type: 'message.posted', time: '2026-10-03T10:00:00Z',
        data: { text: 'Create a brief', authorId: 'me' },
      },
      {
        id: 'assistant-file', position: 2, type: 'agent.file_changed',
        time: '2026-10-03T10:00:01Z',
        data: { turnId: 'message', path: 'brief.pdf', changeType: 'created' },
      },
    ],
  },
  {
    name: 'your upload in a closed conversation',
    expectedVisible: false,
    rows: [
      {
        id: 'upload', position: 1, type: 'file.uploaded', time: '2026-10-03T10:00:00Z',
        data: {
          conversationId: 'chat', fileId: 'file', uploadedBy: 'me',
          name: 'brief.pdf', size: 1024, mime: 'application/pdf',
        },
      },
      {
        id: 'closed', position: 2, type: 'conversation.closed',
        time: '2026-10-03T10:00:01Z', data: {},
      },
    ],
  },
];

function runDownloadScenario(scenario: DownloadScenario): Promise<void> {
  return checkDownloadVisibility(scenario);
}

const originalViewportWidth = globalThis.innerWidth;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState({}, '', '/');
  Object.defineProperty(globalThis, 'innerWidth', {
    configurable: true, value: originalViewportWidth,
  });
});

it.each(downloadScenarios)('shows Download only when the route can serve $name', runDownloadScenario);

it('reads status without sending another screenshot request', async () => {
  const context = await createCaptureWorkspace();
  context.setReply(0);
  await context.fixture.componentInstance['capture'].start('chat', []);
  const screenshotPosts = context.calls.filter(call =>
    call.startsWith('POST ') && call.includes('/screenshots')).length;
  await context.fixture.componentInstance['checkCaptureStatus']();
  const finalScreenshotPosts = context.calls.filter(call =>
    call.startsWith('POST ') && call.includes('/screenshots')).length;
  expect(finalScreenshotPosts).toBe(screenshotPosts);
  expect(context.calls.some(call => call.startsWith('GET ') && call.includes('/messages')))
    .toBe(true);
  const state = context.fixture.componentInstance['capture'].state();
  expect(state.phase).toBe('unknown');
  if (state.phase === 'unknown') expect(state.checkedAt).toBeDefined();
  expect(context.fixture.componentInstance['chat'].error()).toBe('');
  context.fixture.destroy();
});

it('does not say Files were read after a failed status read', async () => {
  const context = await createCaptureWorkspace();
  context.setReply(0);
  await context.fixture.componentInstance['startCapture']();
  context.fixture.detectChanges();
  expect(context.fixture.componentInstance['capture'].state().phase).toBe('unknown');

  context.setMessageStatus(500);
  await context.fixture.componentInstance['checkCaptureStatus']();
  context.fixture.detectChanges();

  expect(context.root.textContent).toContain('Could not load the conversation');
  expect(context.root.textContent).toContain('Could not read Files at');
  expect(context.root.textContent).toContain('Check status again when the connection returns');
  expect(context.root.textContent).not.toContain('Files read again');
  expect(context.fixture.componentInstance['capture'].state().phase).toBe('unknown');
  context.fixture.destroy();
});

it('keeps a previous load error after a successful refresh on a healthy list', async () => {
  const context = await createCaptureWorkspace([screenshotRow(1)]);
  const chat = context.fixture.componentInstance['chat'];
  context.setMessageStatus(500);
  await chat.load();
  expect(chat.error()).toContain('Could not load the conversation');

  context.setMessageStatus(200);

  expect(await chat.refresh()).toBe(true);
  context.fixture.detectChanges();
  await context.fixture.whenStable();
  expect(chat.error()).toContain('Could not load the conversation');
  expect(context.root.textContent).toContain('Could not load the conversation');
  context.fixture.destroy();
});

it('shows one card and keeps the saved announcement when the feed contains its file', async () => {
  const context = await createCaptureWorkspace();
  await context.fixture.componentInstance['startCapture']();
  await vi.waitFor(() => expect(context.root.querySelectorAll('.screenshot-card'))
    .toHaveLength(1));
  const status = context.root.querySelector('.capture-line');
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.textContent).toContain('Screenshot saved');
  expect(status?.classList.contains('sr-only')).toBe(true);
  context.fixture.destroy();
});

it('keeps the already-saved line for a repeated response with one card', async () => {
  const context = await createCaptureWorkspace([screenshotRow(1)]);
  await context.fixture.componentInstance['startCapture']();
  await vi.waitFor(() => expect(context.root.querySelectorAll('.screenshot-card'))
    .toHaveLength(1));
  context.fixture.detectChanges();
  expect(context.fixture.componentInstance['capture'].state())
    .toMatchObject({ phase: 'saved', fileId: 'screen', repeated: true });
  expect(context.root.querySelector('.capture-line')?.textContent)
    .toContain('Screenshot already saved');
  context.fixture.destroy();
});

it('shows one transcript rejection after the matching rejected event arrives', async () => {
  const context = await createCaptureWorkspace();
  context.setReply(422);
  await context.fixture.componentInstance['startCapture']();
  await vi.waitFor(() => expect(context.root.textContent).toContain('Screenshot rejected'));
  expect(context.root.querySelectorAll('.message-content oc-shared-state .message'))
    .toHaveLength(1);
  expect(context.root.textContent).not.toContain('screen.png');
  context.fixture.destroy();
});

it('moves the capture line announcement to LiveView when the session panel opens', async () => {
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1280 });
  const context = await createCaptureWorkspace();
  context.root.querySelector<HTMLButtonElement>('#panel-toggle')?.click();
  context.fixture.detectChanges();
  const captureLine = context.root.querySelector('.capture-line');
  expect(captureLine?.getAttribute('role')).toBe('status');
  context.root.querySelector<HTMLButtonElement>('#panel-toggle')?.click();
  context.fixture.detectChanges();
  expect(captureLine?.getAttribute('role')).toBeNull();
  expect(context.root.querySelector('.entry-capture-status [role="status"]')
    ?.getAttribute('role')).toBe('status');
  context.fixture.destroy();
});

it('clears the preview, screenshot rows and counts when access is denied', async () => {
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1280 });
  const context = await createCaptureWorkspace([screenshotRow(1)]);
  context.setReply(503);
  await context.fixture.componentInstance['capture'].start('chat', []);
  context.fixture.componentInstance['preview'].set('uploads/chat/screen/screen.png');
  context.fixture.detectChanges();
  context.denyFeedRead();
  await context.fixture.componentInstance['chat'].refresh();
  await vi.waitFor(() => expect(context.fixture.componentInstance['chat'].denied()).toBe(true));
  context.fixture.detectChanges();
  expect(context.fixture.componentInstance['capture'].state()).toEqual({ phase: 'idle' });
  expect(context.fixture.componentInstance['preview']()).toBe('');
  expect(context.root.textContent).toContain('Files unavailable');
  expect(context.root.querySelectorAll('.tab-count').length).toBe(2);
  expect([...context.root.querySelectorAll('.tab-count')]
    .every(count => count.textContent?.trim().startsWith('–'))).toBe(true);
  expect(context.root.textContent).not.toContain('screen.png');
  expect(context.root.querySelector('img[src*="files/view"]')).toBeNull();
  context.fixture.destroy();
});

it('resets the capture state when the conversation changes', async () => {
  const context = await createCaptureWorkspace();
  context.setReply(503);
  await context.fixture.componentInstance['capture'].start('chat', []);
  expect(context.fixture.componentInstance['capture'].state().phase).toBe('failed');
  await context.fixture.componentInstance['chat'].select('another-chat');
  await vi.waitFor(() => expect(context.fixture.componentInstance['capture'].state())
    .toEqual({ phase: 'idle' }));
  context.fixture.destroy();
});

it.each([500, 503, 403])('does not show empty states after a %s conversation read', async status => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const path = input instanceof Request ? input.url : String(input);
    if (path.startsWith('/api/conversations/chat/messages')) {
      return Promise.resolve(new Response('{}', { status }));
    }
    let body: object;
    if (path === '/auth/me') {
      body = { authenticated: true, user: { name: 'Alex' } };
    } else if (path === '/api/chat') {
      body = { memberId: 'me', assistantId: 'assistant' };
    } else if (path.endsWith('/approvals')) {
      body = { cards: [], csrf: 'fixture' };
    } else {
      body = { rows: [] };
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  const socket: SocketLike = {
    readyState: 1, onopen: null, onclose: null, onerror: null,
    onmessage: null, send: vi.fn(), close: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No workspace root');
  const expectedMessage = status === 403 ? 'Access unavailable' : 'Could not load the conversation';
  await vi.waitFor(() => expect(root.textContent).toContain(expectedMessage));
  expect(root.textContent).not.toContain('No messages yet');
  root.querySelector<HTMLButtonElement>('#panel-toggle')?.click();
  await fixture.whenStable();
  expect(root.textContent).not.toContain('No screenshots yet');
});
it('renders streamed replies, wake progress and durable Stop, then replays the stopped partial', async () => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const creation = { conversationId: 'chat', createdBy: 'me', assistantId: 'assistant' };
  const rows = [{
    id: 'create', position: 1, type: 'conversation.created',
    time: '2026-10-02T10:00:00Z', data: creation,
  },
    { id: 'message', position: 2, type: 'message.posted', time: '2026-10-02T10:00:00Z', data: { text: 'Hi', authorId: 'me' } }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const path = input instanceof Request ? input.url : String(input);
    const body = path === '/auth/me' ? { authenticated: true, user: { name: 'Alex Morgan' } } : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path.endsWith('/approvals') ? { cards: [], csrf: 'fixture' } : path === '/api/conversations' ? { rows: [] }
      : { rows, position: 2, generation: 1, computerState: 'starting' };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('No root');
  const root = value;
  await vi.waitFor(() => expect(root.textContent).toContain('Starting your computer'));
  socket.onopen?.(new Event('open')); await fixture.whenStable();
  const message = (type: string, position: number, data: object) => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position,
    row: { id: `r${position}`, type, position, time: '2026-10-02T10:00:00Z', data } }) }));
  message('agent.message_delta', 3, { turnId: 'message', messageId: 'reply', text: 'Hello ' });
  message('agent.message_delta', 4, { turnId: 'message', messageId: 'reply', text: 'there' });
  await fixture.whenStable(); expect(root.textContent).toContain('Hello there');
  message('decision.recorded', 5, { turnId: 'message', reason: 'budget_exhausted' });
  await fixture.whenStable();
  const budgetNotice = root.querySelector('oc-budget-stop-notice');
  expect(budgetNotice?.textContent).toContain('Spending limit reached');
  expect(politeStatusText(root)).toContain('Spending limit reached');
  expect(budgetNotice?.querySelector('[role="alert"]')).toBeNull();
  expect(budgetNotice?.textContent).toContain('An Owner or Admin can review the limit');
  expect(budgetNotice?.textContent).toContain('next monthly budget period (UTC)');
  message('agent.turn_stop_requested', 6, { turnId: 'message' });
  message('agent.message_completed', 7, { turnId: 'message', messageId: 'reply', text: 'Hello there and more' });
  await fixture.whenStable(); expect(root.textContent).toContain('Stopped'); expect(root.textContent).not.toContain('and more');
  expect(root.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it('uploads with progress, retries the same bytes and key, and replays attached files in both views', async () => {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const creation = { conversationId: 'chat', createdBy: 'me', assistantId: 'assistant' };
  const rows = [{
    id: 'create', position: 1, type: 'conversation.created',
    time: '2026-10-03T10:00:00Z', data: creation,
  }];
  let postedText = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'text' in body && typeof body.text === 'string') postedText = body.text;
    }
    return Promise.resolve(new Response(JSON.stringify(path === '/auth/me' ? { authenticated: true, user: { name: 'Alex' } }
      : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' }
      : path.endsWith('/approvals') ? { cards: [], csrf: 'fixture' }
      : path === '/api/conversations' ? { rows: [] } : { rows, position: 1, generation: 1, computerState: 'ready' })));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const requests: XMLHttpRequest[] = [], keys: string[] = [];
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation((name, value) => { if (name === 'Idempotency-Key') keys.push(value); });
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (this: XMLHttpRequest) { requests.push(this); });
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull());
  const input = root.querySelector<HTMLInputElement>('input[type=file]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [new File(['PDF'], 'project.pdf', { type: 'application/pdf' })] });
  input!.dispatchEvent(new Event('change')); await fixture.whenStable();
  await vi.waitFor(() => expect(requests.length).toBe(1));
  requests[0]!.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: 1, total: 2 }));
  await fixture.whenStable(); expect(root.textContent).toContain('50%');
  Object.defineProperty(requests[0], 'status', { value: 503 }); requests[0]!.dispatchEvent(new Event('load'));
  await vi.waitFor(() => expect(root.textContent).toContain('Upload unavailable'));
  const retry = [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry upload');
  expect(retry).toBeDefined(); retry!.click(); await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  Object.defineProperty(requests[1], 'status', { value: 201 });
  Object.defineProperty(requests[1], 'responseText', { value: JSON.stringify({ fileId: 'file' }) });
  requests[1]!.dispatchEvent(new Event('load'));
  const composer = root.querySelector('textarea')!; composer.value = 'Read it'; composer.dispatchEvent(new Event('input'));
  await new Promise(resolve => setTimeout(resolve, 0)); await fixture.whenStable();
  expect(root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);

  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position: 2,
    row: { id: 'upload', position: 2, type: 'file.uploaded', time: '2026-10-03T10:00:01Z', data: { conversationId: 'chat', fileId: 'file', uploadedBy: 'me', name: 'project.pdf', size: 1024, mime: 'application/pdf' } } }) }));
  await fixture.whenStable();
  expect(root.querySelector('.transcript .file-card')?.textContent).toContain('project.pdf');
  const drawer = root.querySelector('oc-hinge-drawer dialog');
  if (!drawer) throw new Error('Missing panel drawer');
  const dialogMethods = { showModal: openPanelDialog, close: closePanelDialog };
  Object.assign(drawer, dialogMethods);
  root.querySelector<HTMLButtonElement>('#panel-toggle')!.click();
  await fixture.whenStable();
  expect(root.querySelector('.panel-section')?.textContent).toContain('Attached by you');
  expect(root.querySelector('.panel-section')?.textContent).toContain('project.pdf');
  drawer.querySelector<HTMLButtonElement>('.back')!.click();
  await fixture.whenStable();
  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'event', version: 1, topic: 'conversation', conversationId: 'chat', generation: 1, position: 3,
    row: { id: 'delivered', position: 3, type: 'file.delivered', time: '2026-10-03T10:00:02Z', data: { fileId: 'file', outcome: 'saved' } } }) }));
  composer.value = 'a'.repeat(32000); composer.dispatchEvent(new Event('input')); await fixture.whenStable();
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
  await vi.waitFor(() => expect(postedText).toBe('a'.repeat(32000)));
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toContain('a'.repeat(24)));

});

it('keeps an upload retry in the same draft conversation after creation catch-up fails and a message is sent', async () => {
  history.replaceState({}, '', '/workspace');
  const created: string[] = []; let failedList = false, messageConversation = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    if (path === '/api/conversations' && init?.method === 'POST' && typeof init.body === 'string') {
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === 'object' && 'conversationId' in body && typeof body.conversationId === 'string') created.push(body.conversationId);
      return Promise.resolve(new Response('{}'));
    }
    if (path === '/api/conversations' && created.length && !failedList) { failedList = true; return Promise.resolve(new Response('{}', { status: 503 })); }
    if (init?.method === 'POST' && path.endsWith('/messages')) messageConversation = path.split('/')[3]!;
    const rows = created.length ? [{ conversationId: created[0], assistantId: 'assistant', createdBy: 'me', createdAt: '2026-10-03T10:00:00Z' }] : [];
    return Promise.resolve(new Response(JSON.stringify(path === '/auth/me' ? { authenticated: true, user: { name: 'Alex' } }
      : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path.endsWith('/approvals') ? { cards: [], csrf: 'fixture' } : path === '/api/conversations' ? { rows }
      : { rows: [], position: 0, generation: 1, computerState: 'ready' })));
  });
  const socket: SocketLike = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
  TestBed.configureTestingModule({ providers: [{ provide: SOCKET_FACTORY, useValue: () => socket }] });
  const opened = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(() => {});
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
  const fixture = TestBed.createComponent(Workspace); await fixture.whenStable();
  const root: unknown = fixture.nativeElement; if (!(root instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(root.querySelector('[aria-label="Attach"]')).not.toBeNull());
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File(['notes'], 'notes.txt')] }); input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(root.textContent).toContain('Retry upload'));
  const field = root.querySelector('textarea')!; field.value = 'Hello'; field.dispatchEvent(new Event('input')); await fixture.whenStable();
  root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
  await vi.waitFor(() => expect(messageConversation).not.toBe(''));
  expect(messageConversation).toBe(created[0]); expect(new Set(created).size).toBe(1);
  await fixture.whenStable();
  [...root.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry upload')!.click();
  await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('POST', `/api/conversations/${created[0]}/files`));
});

function toolRows(): Record<string, unknown>[] {
  return [
    { id: 'message', position: 1, type: 'message.posted',
      time: '2026-10-04T10:00:00Z', data: { text: 'Run the command', authorId: 'me' } },
    { id: 'command', position: 2, type: 'agent.command_ran',
      time: '2026-10-04T10:01:00Z', data: { turnId: 'message', exitCode: 1 } },
  ];
}

it('opens tool details from the line and focuses the line from Activity', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.assign(HTMLDialogElement.prototype, {
    showModal: openPanelDialog,
    close: closePanelDialog,
  });
  const capture = await createCaptureWorkspace(toolRows());
  const toolLine = capture.root.querySelector<HTMLButtonElement>('.tool-line');
  if (!toolLine) throw new Error('Missing tool line');
  Object.defineProperty(toolLine, 'getClientRects', {
    value: () => [{ width: 100, height: 44 }],
  });

  capture.fixture.componentInstance['jumpToTool']('command');
  capture.fixture.detectChanges();
  expect(document.activeElement).toBe(toolLine);
  expect(toolLine.closest('.message')?.classList.contains('highlighted')).toBe(true);

  toolLine.click();
  await capture.fixture.whenStable();
  capture.fixture.detectChanges();
  const dialogs = Array.from(capture.root.querySelectorAll<HTMLDialogElement>(
    'oc-hinge-drawer dialog',
  ));
  const dialog = dialogs.find(candidate => candidate.querySelector('h2')?.textContent
    === 'Command failed');
  expect(dialog?.querySelector('h2')?.textContent).toBe('Command failed');
  expect(document.activeElement).toBe(dialog?.querySelector('h2'));
  expect(dialog?.textContent).toContain('Failed · Exit code 1');
  expect(dialog?.textContent).toContain('4 Oct 2026, 10:01 UTC');
  expect(dialog?.textContent).toContain('Reference');
  expect(dialog?.textContent).toContain('Not available yet');

  dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
  await capture.fixture.whenStable();
  expect(document.activeElement).toBe(toolLine);
});

it('announces one recovery after the socket reconnects and its conversation is ready', async () => {
  const capture = await createCaptureWorkspace();
  const field = capture.root.querySelector<HTMLTextAreaElement>('textarea');
  field?.focus();
  const originalOpen = capture.socket.onopen;
  originalOpen?.(new Event('open'));
  capture.socket.onclose?.(new CloseEvent('close'));
  await vi.waitFor(() => expect(capture.socket.onopen).not.toBe(originalOpen));
  capture.socket.onopen?.(new Event('open'));

  const readyMessage = {
    version: 1,
    topic: 'conversation',
    conversationId: 'chat',
    type: 'ready',
    position: 0,
    generation: 1,
    computerState: 'ready',
  };
  capture.socket.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify(readyMessage),
  }));
  await capture.fixture.whenStable();
  capture.fixture.detectChanges();

  const reconnected = capture.root.querySelector('.reconnected-line');
  expect(reconnected?.textContent).toContain('Reconnected at');
  expect(capture.root.querySelectorAll('.reconnected-line')).toHaveLength(1);
  expect(capture.fixture.componentInstance['chat'].announcement()).toMatch(/Reconnected at/);
  expect(document.activeElement).toBe(field);

  capture.fixture.componentInstance['chat'].announcement.set('');
  capture.fixture.componentInstance['chat'].reconnectedAt.set('');
  capture.socket.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify({ ...readyMessage, computerState: 'starting' }),
  }));
  await capture.fixture.whenStable();
  capture.fixture.detectChanges();
  expect(capture.root.querySelector('.reconnected-line')).toBeNull();
  expect(capture.fixture.componentInstance['chat'].reconnectedAt()).toBe('');
  expect(capture.fixture.componentInstance['chat'].announcement()).toBe('');

  capture.socket.onclose?.(new CloseEvent('close'));
  const previousOpen = capture.socket.onopen;
  await vi.waitFor(() => expect(capture.socket.onopen).not.toBe(previousOpen));
  capture.socket.onopen?.(new Event('open'));
  capture.socket.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify(readyMessage),
  }));
  await capture.fixture.whenStable();
  expect(capture.fixture.componentInstance['chat'].announcement())
    .toMatch(/Reconnected again at/);
});

it('does not announce a reconnect that started in the conversation being left', async () => {
  const capture = await createCaptureWorkspace();
  capture.socket.onopen?.(new Event('open'));
  capture.socket.onclose?.(new CloseEvent('close'));
  await capture.fixture.whenStable();

  await capture.fixture.componentInstance['chat'].select('other');
  capture.socket.onopen?.(new Event('open'));
  capture.socket.onmessage?.(new MessageEvent('message', {
    data: JSON.stringify({
      version: 1,
      topic: 'conversation',
      conversationId: 'other',
      type: 'ready',
      position: 0,
      generation: 1,
      computerState: 'ready',
    }),
  }));
  await capture.fixture.whenStable();
  capture.fixture.detectChanges();

  expect(capture.root.querySelector('.reconnected-line')).toBeNull();
  expect(capture.fixture.componentInstance['chat'].reconnectedAt()).toBe('');
  expect(capture.fixture.componentInstance['chat'].announcement()).toBe('');
});

it('shows Waiting on you without adding another live announcement', async () => {
  const approval = {
    approvalId: 'a'.repeat(64), conversationId: 'chat', requesterId: 'me',
    expiresAt: '2026-10-04T10:32:00Z', state: 'requested', stepUp: false, canDecide: true,
    review: { action: 'Change the note', tool: 'write', target: 'SO-1042', data: '{}',
      destination: 'ERP', account: 'No account', consequence: 'Changes the draft.' },
  };
  const capture = await createCaptureWorkspace([], path =>
    path.includes('/conversations/chat/approvals') ? [approval] : []);
  try {
    await vi.waitFor(() => expect(capture.root.textContent).toContain('Waiting on you'));
    const headerStatus = capture.root.querySelector('.waiting-status');
    expect(headerStatus?.getAttribute('aria-live')).toBe('polite');
    expect(capture.root.querySelectorAll('.workspace-header [aria-live]')).toHaveLength(1);
    await capture.fixture.componentInstance['chat'].select('county-rollout');
    await vi.waitFor(() => expect(capture.root.textContent).not.toContain('Waiting on you'));
    expect(capture.root.querySelector('.waiting-status')).toBeNull();
  } finally {
    capture.fixture.destroy();
  }
});

it('uses Enter in the message field to submit its text', () => {
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.componentRef.setInput('draft', 'Check the order note');
  fixture.detectChanges();
  const submitted: string[] = [];
  fixture.componentInstance.submitted.subscribe(text => submitted.push(text));
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Message composer is missing');
  const field = root.querySelector<HTMLTextAreaElement>('#message');
  if (!field) throw new Error('Message field is missing');
  field.focus();
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  field.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(submitted).toEqual(['Check the order note']);
  fixture.destroy();
});

it('clears Waiting on you when the approval cards are destroyed', async () => {
  const approval = {
    approvalId: 'a'.repeat(64), conversationId: 'chat', requesterId: 'me',
    expiresAt: '2026-10-04T10:32:00Z', state: 'requested', stepUp: false, canDecide: true,
    review: { action: 'Change the note', tool: 'write', target: 'SO-1042', data: '{}',
      destination: 'ERP', account: 'No account', consequence: 'Changes the draft.' },
  };
  const capture = await createCaptureWorkspace([], path =>
    path.includes('/conversations/chat/approvals') ? [approval] : []);
  try {
    await vi.waitFor(() => expect(capture.root.textContent).toContain('Waiting on you'));
    capture.fixture.componentInstance['chat'].newSession();
    capture.fixture.detectChanges();
    await capture.fixture.componentInstance['chat'].select('county-rollout');
    await vi.waitFor(() => expect(capture.root.textContent).not.toContain('Waiting on you'));
    expect(capture.root.querySelector('.waiting-status')).toBeNull();
  } finally {
    capture.fixture.destroy();
  }
});

it('shows lost private output as incomplete and never offers Stop or Done', async () => {
  const rows = [
    { id: 'message', position: 1, type: 'message.posted', time: '2026-10-06T10:00:00Z',
      data: { authorId: 'me', text: 'Draft the reply.' } },
    { id: 'started', position: 2, type: 'agent.turn_started', time: '2026-10-06T10:00:01Z',
      data: { turnId: 'message', executionMode: 'restricted' } },
    { id: 'lost', position: 3, type: 'agent.output_lost', time: '2026-10-06T10:01:00Z',
      data: { turnId: 'message' } },
    { id: 'completed', position: 4, type: 'agent.turn_completed', time: '2026-10-06T10:01:01Z',
      data: { turnId: 'message' } },
  ];
  const capture = await createCaptureWorkspace(rows, [], 'team');
  try {
    expect(capture.root.textContent).toContain("Didn't complete · nothing was repeated");
    expect(capture.root.textContent).not.toContain('Done');
    expect(capture.root.querySelector('.turn-status')).not.toBeNull();
    expect(capture.root.querySelector('.turn-status')?.textContent).not.toContain('Stop');
  } finally {
    capture.fixture.destroy();
  }
});

it('disables the team composer during recovery and shows the last confirmed turn', async () => {
  const rows = [
    { id: 'confirmed-message', position: 1, type: 'message.posted',
      time: '2026-10-06T09:59:00Z', data: { authorId: 'me', text: 'Earlier request.' } },
    { id: 'confirmed-turn', position: 2, type: 'agent.turn_completed',
      time: '2026-10-06T10:01:00Z', data: { turnId: 'confirmed-message' } },
    { id: 'active-message', position: 3, type: 'message.posted',
      time: '2026-10-06T10:02:00Z', data: { authorId: 'me', text: 'Current request.' } },
    { id: 'active-start', position: 4, type: 'agent.turn_started',
      time: '2026-10-06T10:02:01Z', data: { turnId: 'active-message', executionMode: 'restricted' } },
    { id: 'active-delta', position: 5, type: 'agent.message_delta',
      time: '2026-10-06T10:02:02Z', data: { turnId: 'active-message', messageId: 'reply', text: 'Working' } },
  ];
  const capture = await createCaptureWorkspace(rows, [], 'team', 'recovering');
  try {
    expect(capture.root.textContent).toContain('Recovering your authorised context');
    expect(capture.root.textContent).toContain('last confirmed turn was at');
    expect(capture.root.querySelector<HTMLTextAreaElement>('#message')?.disabled).toBe(true);
    expect(capture.root.querySelector('[aria-label="Attach"]')).toBeNull();
    expect(capture.root.querySelector('.stop')).toBeNull();
  } finally {
    capture.fixture.destroy();
  }
});

it('keeps a memory-free choice in the draft and does not send it', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const field = capture.root.querySelector<HTMLTextAreaElement>('#message');
    if (!field) throw new Error('Message field is missing');
    field.value = 'Review the order note';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    capture.fixture.detectChanges();

    const memoryFreeButton = [...capture.root.querySelectorAll<HTMLButtonElement>(
      'oc-memory-free-notice button')]
      .find(button => button.textContent?.includes('Start a fresh memory-free turn'));
    if (!memoryFreeButton) throw new Error('Memory-free choice is missing');
    memoryFreeButton.click();
    capture.fixture.detectChanges();

    expect(field.value).toBe('Review the order note');
    expect(capture.root.textContent).toContain('This turn has no earlier context');
    expect(capture.root.textContent).toContain('This mode applies to your next turn');
    expect(capture.calls.filter(call => call.startsWith('POST '))).toEqual([]);
    expect(capture.root.querySelector('[aria-label="Attach"]')).toBeNull();

    capture.root.querySelector<HTMLButtonElement>('.send')?.click();
    await capture.fixture.whenStable();
    expect(capture.postBodies.at(-1)).toMatchObject({
      text: 'Review the order note', executionMode: 'memory_free',
    });
  } finally {
    capture.fixture.destroy();
  }
});

it('shows the saved paying group id in a private team session', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    expect(capture.root.textContent).toContain('Paying group ID: opaque-sales');
    expect(capture.root.textContent).toContain("The group's name is not available to members yet.");
    expect(capture.root.querySelector('.avatar.agent')?.getAttribute('aria-label'))
      .toBe('Shared assistant');
  } finally {
    capture.fixture.destroy();
  }
});

function isDisabledModeButton(button: HTMLButtonElement): boolean {
  return button.disabled;
}

function isStopButton(button: HTMLButtonElement): boolean {
  return button.textContent?.trim() === 'Stop';
}

function memoryModeButtons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.mode-choice button')];
}

it('flips the composer footnote to match the selected memory mode', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const footnote = capture.root.querySelector('.composer-footnote');
    expect(footnote?.textContent).toContain("this turn is not saved on the shared computer's disk");
    memoryModeButtons(capture.root)[1]!.click();
    capture.fixture.detectChanges();
    expect(footnote?.textContent).toContain(
      "This turn has no earlier context and writes to the shared computer's disk");
    expect(capture.root.querySelector('.composer-dock')?.textContent)
      .toContain('This turn has no earlier context');
    memoryModeButtons(capture.root)[0]!.click();
    capture.fixture.detectChanges();
    expect(footnote?.textContent).toContain("this turn is not saved on the shared computer's disk");
  } finally {
    capture.fixture.destroy();
  }
});

it('locks the mode of a queued memory-free message and retries that same command', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const chat = capture.fixture.componentInstance['chat'];
    chat.chooseMemoryFree();
    capture.setMessageStatus(503);
    expect(await chat.send('Keep this mode')).toBe(false);
    capture.fixture.detectChanges();
    const buttons = memoryModeButtons(capture.root);
    expect(buttons.every(isDisabledModeButton)).toBe(true);
    expect(capture.root.textContent).toContain('Retry or discard the queued message first');
    buttons[0]!.click();
    chat.choosePrivate();
    expect(chat.executionMode()).toBe('memory_free');
    capture.setMessageStatus(200);
    expect(await chat.send('Keep this mode')).toBe(true);
    expect(capture.postBodies.at(-1)).toEqual(capture.postBodies.at(-2));
    expect(capture.postBodies.at(-1)).toMatchObject({ executionMode: 'memory_free' });
  } finally {
    capture.fixture.destroy();
  }
});

function recoveredTurnRows(state: 'lost' | 'done'): ChatRow[] {
  const rows: ChatRow[] = [
    { id: 'request', position: 1, type: 'message.posted', time: '2026-10-06T10:02:00Z',
      data: { authorId: 'me', text: 'My request' } },
  ];
  const type = state === 'lost' ? 'agent.output_lost' : 'agent.turn_completed';
  rows.push({ id: 'outcome', position: 2, type, time: '2026-10-06T10:03:01Z',
    data: { turnId: 'request' } });
  return rows;
}

it('shows the fresh-computer lost-request notice only for the affected last turn', async () => {
  const capture = await createCaptureWorkspace(recoveredTurnRows('done'), [], 'team');
  try {
    const chat = capture.fixture.componentInstance['chat'];
    chat.computerRecovered.set(true);
    chat.computerLostAt.set('2026-10-06T10:03:00Z');
    capture.fixture.detectChanges();
    expect(capture.root.textContent).not.toContain("Your last request didn't complete");
    chat.rows.set(recoveredTurnRows('lost'));
    capture.fixture.detectChanges();
    expect(capture.root.textContent).toContain("Your last request didn't complete");
    chat.computerLostAt.set('2026-10-06T10:04:00Z');
    capture.fixture.detectChanges();
    expect(capture.root.textContent).not.toContain("Your last request didn't complete");
    chat.computerLostAt.set('2026-10-06T10:03:00Z');
    const later = recoveredTurnRows('done');
    later[0]!['id'] = 'later';
    later[0]!['position'] = 3;
    later[1]!['position'] = 4;
    later[1]!['data'] = { turnId: 'later' };
    const updatedRows = [...chat.rows(), ...later];
    chat.rows.set(updatedRows);
    capture.fixture.detectChanges();
    expect(capture.root.textContent).not.toContain("Your last request didn't complete");
    chat.rows.set([]);
    capture.fixture.detectChanges();
    expect(capture.root.textContent).not.toContain("Your last request didn't complete");
  } finally {
    capture.fixture.destroy();
  }
});

it('announces memory-free selection and focuses the composer from the notice', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const button = capture.root.querySelector<HTMLButtonElement>('oc-memory-free-notice button')!;
    button.focus();
    button.click();
    capture.fixture.detectChanges();
    expect(document.activeElement).toBe(capture.root.querySelector('#message'));
    expect(capture.fixture.componentInstance['chat'].announcement())
      .toBe('Memory-free selected. This turn has no earlier context and writes to the shared disk.');
  } finally {
    capture.fixture.destroy();
  }
});

it('announces recovery, explains it in personal chats and restores lost composer focus', async () => {
  const capture = await createCaptureWorkspace();
  try {
    const chat = capture.fixture.componentInstance['chat'];
    const field = capture.root.querySelector<HTMLTextAreaElement>('#message')!;
    field.focus();
    const recovering = { version: 1, type: 'ready', topic: 'conversation',
      conversationId: 'chat', generation: 1, position: 0, computerState: 'recovering' };
    capture.socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(recovering) }));
    capture.fixture.detectChanges();
    expect(chat.announcement()).toBe('Your computer is recovering. Sending is paused.');
    expect(capture.root.textContent).toContain('Recovering your authorised context');
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    const ready = { ...recovering, computerState: 'ready' };
    capture.socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(ready) }));
    capture.fixture.detectChanges();
    expect(chat.announcement()).toBe('Your computer is ready again. You can send.');
    expect(document.activeElement).toBe(field);
  } finally {
    capture.fixture.destroy();
  }
});

it('places recovery after the last reply and hides both Stop buttons', async () => {
  const capture = await createCaptureWorkspace([
    { id: 'request', position: 1, type: 'message.posted', time: '2026-10-06T10:02:00Z',
      data: { authorId: 'me', text: 'Work on this' } },
    { id: 'delta', position: 2, type: 'agent.message_delta', time: '2026-10-06T10:02:01Z',
      data: { turnId: 'request', messageId: 'reply', text: 'Partial reply' } },
  ], [], 'team', 'recovering');
  try {
    const notice = capture.root.querySelector('oc-recovery-notice')!;
    const lastReply = capture.root.querySelectorAll('article').item(1);
    expect(lastReply.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    const stopButtons = [...capture.root.querySelectorAll('button')]
      .filter(isStopButton);
    expect(stopButtons).toHaveLength(0);
  } finally {
    capture.fixture.destroy();
  }
});

it('pauses queued Retry during recovery and keeps the pending message mode', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const chat = capture.fixture.componentInstance['chat'];
    capture.setMessageStatus(503);
    await chat.send('Wait for recovery');
    const before = capture.postBodies.length;
    chat.computer.set('recovering');
    capture.setMessageStatus(200);
    capture.fixture.detectChanges();
    const retry = capture.root.querySelector<HTMLButtonElement>('.connection-strip button')!;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toContain('Sending is paused');
    expect(await chat.send('Wait for recovery')).toBe(false);
    expect(capture.postBodies).toHaveLength(before);
  } finally {
    capture.fixture.destroy();
  }
});

it('sends team turns privately by default and resets memory-free after a 200 receipt', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const chat = capture.fixture.componentInstance['chat'];
    expect(await chat.send('Default private')).toBe(true);
    expect(capture.postBodies.at(-1)).not.toHaveProperty('executionMode');
    chat.rows.set([]);
    chat.chooseMemoryFree();
    expect(await chat.send('One memory-free turn')).toBe(true);
    expect(capture.postBodies.at(-1)).toMatchObject({ executionMode: 'memory_free' });
    expect(chat.executionMode()).toBe('restricted');
    chat.rows.set([]);
    expect(await chat.send('Private again')).toBe(true);
    expect(capture.postBodies.at(-1)).not.toHaveProperty('executionMode');
    expect(capture.postBodies.at(-1)).not.toMatchObject({ id: z.object({ id: z.string() }).parse(capture.postBodies.at(-2)).id });
  } finally {
    capture.fixture.destroy();
  }
});

it('omits executionMode in personal chats even when the mode signal is memory-free', async () => {
  const capture = await createCaptureWorkspace();
  try {
    const chat = capture.fixture.componentInstance['chat'];
    chat.chooseMemoryFree();
    expect(await chat.send('Personal request')).toBe(true);
    expect(capture.postBodies.at(-1)).not.toHaveProperty('executionMode');
  } finally {
    capture.fixture.destroy();
  }
});

it('keeps partial lost output and counts only a genuinely completed turn as confirmed', async () => {
  const capture = await createCaptureWorkspace([
    { id: 'done', position: 1, type: 'message.posted', time: '2026-10-06T10:00:00Z',
      data: { authorId: 'me', text: 'Earlier' } },
    { id: 'done-end', position: 2, type: 'agent.turn_completed', time: '2026-10-06T10:01:00Z',
      data: { turnId: 'done' } },
    { id: 'lost', position: 3, type: 'message.posted', time: '2026-10-06T10:02:00Z',
      data: { authorId: 'me', text: 'Later' } },
    { id: 'partial', position: 4, type: 'agent.message_delta', time: '2026-10-06T10:02:01Z',
      data: { turnId: 'lost', messageId: 'reply', text: 'Partial answer' } },
    { id: 'lost-output', position: 5, type: 'agent.output_lost', time: '2026-10-06T10:03:01Z',
      data: { turnId: 'lost' } },
    { id: 'lost-end', position: 6, type: 'agent.turn_completed', time: '2026-10-06T10:04:00Z',
      data: { turnId: 'lost' } },
  ], [], 'team', 'recovering');
  try {
    expect(capture.root.textContent).toContain('Reply did not complete · partial reply kept');
    expect(capture.root.textContent).toContain('Your last confirmed turn was at 10:01');
    const chat = capture.fixture.componentInstance['chat'];
    const withoutCompletion = chat.rows().slice(0, -1);
    chat.rows.set(withoutCompletion);
    chat.computer.set('ready');
    capture.fixture.detectChanges();
    const stopButtons = [...capture.root.querySelectorAll('button')]
      .filter(isStopButton);
    expect(stopButtons).toHaveLength(0);
  } finally {
    capture.fixture.destroy();
  }
});

it('clears recovered state when switching chats before the new feed arrives', async () => {
  const capture = await createCaptureWorkspace();
  try {
    const chat = capture.fixture.componentInstance['chat'];
    chat.computerRecovered.set(true);
    chat.computerLostAt.set('2026-10-06T10:03:00Z');
    const selection = chat.select('another');
    expect(chat.computerRecovered()).toBe(false);
    expect(chat.computerLostAt()).toBe('');
    await selection;
  } finally {
    capture.fixture.destroy();
  }
});

it('keeps typed text and a single pending command after a lost send reply', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const field = capture.root.querySelector<HTMLTextAreaElement>('#message')!;
    field.value = 'Keep my words';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    capture.fixture.detectChanges();
    capture.setMessageStatus(0);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await capture.fixture.whenStable();
    capture.fixture.detectChanges();
    expect(capture.postBodies).toHaveLength(1);
    expect(field.value).toBe('Keep my words');
    const command = z.object({ id: z.string() }).parse(capture.postBodies[0]);
    expect(capture.root.textContent).toContain(command.id);
    const chat = capture.fixture.componentInstance['chat'];
    await chat.select('another');
    chat.newSession();
    expect(chat.selected()).toBe('chat');
    expect(capture.postBodies).toHaveLength(1);
    expect(capture.root.textContent).toContain("We couldn't tell whether your message was recorded");
  } finally {
    capture.fixture.destroy();
  }
});

it('keeps typed text on a refused send and does not report a healthy refresh as failed', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const field = capture.root.querySelector<HTMLTextAreaElement>('#message')!;
    field.value = 'My draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    capture.fixture.detectChanges();
    capture.setMessageStatus(400);
    capture.root.querySelector<HTMLButtonElement>('.send')!.click();
    await capture.fixture.whenStable();
    expect(field.value).toBe('My draft');
    capture.setMessageStatus(200);
    const chat = capture.fixture.componentInstance['chat'];
    chat.error.set('');
    expect(await chat.refresh()).toBe(true);
    expect(chat.error()).toBe('');
    expect(field.value).toBe('My draft');
  } finally {
    capture.fixture.destroy();
  }
});

it('checks a lost send reply with a 200 receipt and clears its pending command', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    const chat = capture.fixture.componentInstance['chat'];
    capture.setMessageStatus(0);
    expect(await chat.send('Already received')).toBe(false);
    const command = z.object({ id: z.string() }).parse(capture.postBodies[0]);
    capture.confirmPendingMessage();
    expect(await chat.send('Already received')).toBe(true);
    expect(capture.postBodies).toHaveLength(1);
    expect(capture.calls).toContain(`GET /api/conversations/chat/changes/${command.id}`);
    expect(chat.queued()).toBe(false);
    chat.rows.set([]);
    capture.setMessageStatus(200);
    expect(await chat.send('Next message')).toBe(true);
    expect(capture.postBodies.at(-1)).not.toMatchObject({ id: command.id });
  } finally {
    capture.fixture.destroy();
  }
});

function isConversationCreation(body: unknown): body is { id: string; conversationId: string } {
  const schema = z.object({ id: z.string(), conversationId: z.string() });
  return schema.safeParse(body).success;
}

it('creates two fresh conversations in one visit with separate commands', async () => {
  const capture = await createCaptureWorkspace();
  try {
    const chat = capture.fixture.componentInstance['chat'];
    chat.newSession();
    expect(await chat.send('First new conversation')).toBe(true);
    chat.newSession();
    expect(await chat.send('Second new conversation')).toBe(true);
    const creates = capture.postBodies.filter(isConversationCreation);
    expect(creates).toHaveLength(2);
    expect(creates[1]!.conversationId).not.toBe(creates[0]!.conversationId);
    expect(creates[1]!.id).not.toBe(creates[0]!.id);
  } finally {
    capture.fixture.destroy();
  }
});

it('keeps a message pending until its send returns a 200 receipt', async () => {
  const capture = await createCaptureWorkspace([], [], 'team');
  try {
    capture.setMessageStatus(202);
    const chat = capture.fixture.componentInstance['chat'];
    expect(await chat.send('Wait for the receipt')).toBe(false);
    expect(chat.queued()).toBe(true);
    expect(chat.turns()).toHaveLength(0);
  } finally {
    capture.fixture.destroy();
  }
});

async function loadsChatWithDeliveredUpload(outcome: string) {
  const rows = toolRows();
  const upload = { id: 'upload', position: rows.length + 1, type: 'file.uploaded',
    time: '2026-10-03T10:00:01Z', data: { conversationId: 'chat', fileId: 'file',
      uploadedBy: 'me', name: 'notes.txt', size: 5, mime: 'text/plain' } };
  rows.push(upload);
  const delivered = { id: 'delivered', position: rows.length + 1, type: 'file.delivered',
    time: '2026-10-03T10:00:02Z', data: { fileId: 'file', outcome } };
  rows.push(delivered);
  const capture = await createCaptureWorkspace(rows);
  expect(capture.root.textContent).not.toContain('Could not load the conversation');
  expect(capture.root.querySelector('.transcript .file-card')?.textContent).toContain('notes.txt');
  expect(capture.root.querySelector('.tool-line')).not.toBeNull();
}
it.each(['saved', 'kept_existing'])(
  'loads the workspace with legacy rows and an upload with outcome %s', loadsChatWithDeliveredUpload);
