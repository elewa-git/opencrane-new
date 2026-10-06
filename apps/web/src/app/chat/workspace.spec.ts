import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Workspace } from './workspace';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

interface CaptureWorkspace {
  fixture: ComponentFixture<Workspace>;
  root: HTMLElement;
  calls: string[];
  setReply(status: number): void;
  denyFeedRead(): void;
  setMessageStatus(status: number): void;
  rows: Record<string, unknown>[];
}

async function createCaptureWorkspace(initialRows: Record<string, unknown>[] = []): Promise<CaptureWorkspace> {
  history.replaceState({}, '', '/workspace?conversation=chat');
  const rows = [...initialRows];
  const calls: string[] = [];
  let replyStatus = 201;
  let denyMessages = false;
  let messageStatus = 200;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = input instanceof Request ? input.url : String(input);
    const pathname = new URL(path, location.origin).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (pathname === '/auth/me') {
      return Promise.resolve(new Response('{"authenticated":true,"user":{"name":"Alex"}}'));
    }
    if (pathname === '/api/chat') {
      return Promise.resolve(new Response('{"memberId":"me","assistantId":"assistant"}'));
    }
    if (pathname === '/api/conversations' && init?.method !== 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ rows: [{
        conversationId: 'chat', assistantId: 'assistant', createdBy: 'me',
        createdAt: '2026-10-03T10:00:00Z', status: 'open', mode: 'agent_session',
      }] })));
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
    if (pathname.endsWith('/messages')) {
      if (denyMessages) return Promise.resolve(new Response('{}', { status: 403 }));
      if (messageStatus !== 200) {
        return Promise.resolve(new Response('{}', { status: messageStatus }));
      }
      const since = Number(new URL(path, location.origin).searchParams.get('since') ?? 0);
      const visibleRows = rows.filter(row => Number(row['position']) > since);
      return Promise.resolve(new Response(JSON.stringify({ rows: visibleRows,
        position: rows.length, generation: 1, computerState: 'ready' })));
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
  ] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  await vi.waitFor(() => expect(fixture.componentInstance['chat'].selected()).toBe('chat'));
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing workspace root');
  return {
    fixture, root, calls, rows,
    setReply(status) { replyStatus = status; },
    denyFeedRead() { denyMessages = true; },
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
    const body = path === '/auth/me' ? { authenticated: true, user: { name: 'Alex Morgan' } } : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path === '/api/conversations' ? { rows: [] }
      : { rows, position: 2, generation: 1, computerState: 'starting your computer' };
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
    row: { id: 'delivered', position: 3, type: 'file.delivered', time: '2026-10-03T10:00:02Z', data: { fileId: 'file' } } }) }));
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
      : path === '/api/chat' ? { memberId: 'me', assistantId: 'assistant' } : path === '/api/conversations' ? { rows }
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
