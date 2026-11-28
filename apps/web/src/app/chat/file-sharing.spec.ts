import { TestBed } from '@angular/core/testing';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';
import { Workspace } from './workspace';

const time = '2026-11-28T05:00:00Z';
const conversation = {
  conversationId: 'chat', assistantId: 'assistant', createdBy: 'me',
  createdAt: time, mode: 'agent_session', status: 'open',
};
const filePath = '/workspace/notes/Meet_Aster.html';
const reply = {
  id: 'reply', position: 2, type: 'agent.message_delta', time,
  data: { turnId: 'question', messageId: 'answer', text: `[My slides](${filePath})` },
};
const completed = {
  id: 'done', position: 3, type: 'agent.turn_completed', time,
  data: { turnId: 'question' },
};
const question = {
  id: 'question', position: 1, type: 'message.posted', time,
  data: { authorId: 'me', text: 'Make slides introducing yourself' },
};

function createSocket(): SocketLike {
  return {
    readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
    send: vi.fn(), close: vi.fn(),
  };
}

async function mountWorkspace() {
  const posted: unknown[] = [];
  let responseStatus = 200;
  function readRequest(input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, location.origin).pathname;
    let body: object = {};
    if (path === '/auth/me') body = { authenticated: true, user: { name: 'Sam' } };
    if (path === '/api/chat') body = { memberId: 'me', assistantId: 'assistant' };
    if (path === '/api/conversations') body = { rows: [conversation] };
    if (path.includes('/changes/')) {
      const missing = new Response('{}', { status: 404 });
      return Promise.resolve(missing);
    }
    if (path.includes('/messages')) {
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Expected a JSON message');
        posted.push(JSON.parse(init.body) as unknown);
        return Promise.resolve(new Response('{}', { status: responseStatus }));
      }
      body = { rows: [question, reply, completed], position: 3,
        generation: 1, computerState: 'ready' };
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  }
  function setResponseStatus(status: number) {
    responseStatus = status;
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(readRequest);
  history.replaceState({}, '', '/workspace?conversation=chat');
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  TestBed.configureTestingModule({ providers: [provider] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing workspace');
  const root = element;
  function replyLoaded() {
    fixture.detectChanges();
    expect(root.querySelector('.workspace-file-note')?.textContent)
      .toContain('Meet_Aster.html');
  }
  await vi.waitFor(replyLoaded);
  const share = root.querySelector<HTMLButtonElement>('.workspace-file-share');
  expect(share?.textContent?.trim()).toBe('Share');
  if (!share) throw new Error('Missing Share action');
  return { fixture, root, share, posted, setResponseStatus };
}

afterEach(function restoreBrowser() {
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

async function requestsFileInOneStep() {
  const context = await mountWorkspace();
  expect(context.root.textContent).toContain('Meet_Aster.html — not shared by the agent.');
  expect(context.share.getAttribute('aria-label')).toBe('Share Meet_Aster.html');
  expect(context.root.querySelector('oc-conversation-file-card')).toBeNull();
  context.share.click();
  context.share.click();
  await context.fixture.whenStable();
  expect(context.posted).toHaveLength(1);
  expect(context.fixture.componentInstance['draft']()).toBe('');
  expect(context.fixture.componentInstance['chat'].error()).toBe('');
  expect(context.posted[0]).toMatchObject({
    text: `Please share a fresh copy of "${filePath}" in this chat.`,
  });
  expect(context.root.querySelector('oc-conversation-file-card')).toBeNull();
  context.fixture.destroy();
}

it('asks the assistant to share a fresh copy with one click, without inventing a file card',
  requestsFileInOneStep);

async function protectsDraftAndAttachments() {
  const context = await mountWorkspace();
  const workspace = context.fixture.componentInstance;
  workspace['draft'].set('My unfinished question');
  context.fixture.detectChanges();
  expect(context.share.disabled).toBe(true);
  context.share.click();
  expect(context.posted).toHaveLength(0);
  expect(workspace['draft']()).toBe('My unfinished question');
  workspace['draft'].set('');
  const batch = workspace['chat'].uploadBatch;
  batch.start(new File(['Notes'], 'notes.txt'), 'chat', 'upload');
  batch.confirmed('file');
  context.fixture.detectChanges();
  expect(context.share.disabled).toBe(true);
  context.share.click();
  expect(context.posted).toHaveLength(0);
  context.fixture.destroy();
}

it('keeps an unfinished draft and prepared attachments out of the Share request',
  protectsDraftAndAttachments);

async function blocksUnavailableSessions() {
  const context = await mountWorkspace();
  const chat = context.fixture.componentInstance['chat'];
  chat.computer.set('recovering');
  context.fixture.detectChanges();
  expect(context.share.disabled).toBe(true);
  context.share.click();
  expect(context.posted).toHaveLength(0);
  chat.computer.set('ready');
  const rows = chat.rows();
  function closeSession() {
    const closed = { id: 'close', position: 4, type: 'conversation.closed' as const, time,
      data: { conversationId: 'chat', closedBy: 'me' } };
    return [...rows, closed];
  }
  chat.rows.update(closeSession);
  context.fixture.detectChanges();
  expect(context.share.disabled).toBe(true);
  context.share.click();
  expect(context.posted).toHaveLength(0);
  context.fixture.destroy();
}

it('keeps Share disabled during recovery and after the session closes', blocksUnavailableSessions);

async function keepsRefusedRequestVisible() {
  const context = await mountWorkspace();
  context.setResponseStatus(403);
  context.share.click();
  await context.fixture.whenStable();
  const chat = context.fixture.componentInstance['chat'];
  expect(context.posted).toHaveLength(1);
  expect(chat.denied()).toBe(true);
  context.fixture.detectChanges();
  expect(context.root.textContent).toContain('You no longer have access');
  expect(context.root.querySelector('oc-conversation-file-card')).toBeNull();
  context.fixture.destroy();
}

it('shows an access refusal without claiming the file was shared', keepsRefusedRequestVisible);

async function retriesTheSameShareRequest() {
  const context = await mountWorkspace();
  context.setResponseStatus(503);
  context.share.click();
  await context.fixture.whenStable();
  const workspace = context.fixture.componentInstance;
  function requestQueued() {
    context.fixture.detectChanges();
    expect(workspace['chat'].queued()).toBe(true);
    expect(workspace['chat'].busy()).toBe(false);
  }
  await vi.waitFor(requestQueued);
  expect(workspace['draft']()).toContain('Please share a fresh copy of');
  expect(context.share.disabled).toBe(true);
  context.setResponseStatus(200);
  const retry = context.root.querySelector<HTMLButtonElement>('.composer-dock .connection-strip button');
  expect(retry?.textContent).toBe('Retry');
  retry?.click();
  function requestSent() {
    expect(context.posted).toHaveLength(2);
    expect(workspace['draft']()).toBe('');
  }
  await vi.waitFor(requestSent);
  expect(context.posted[1]).toEqual(context.posted[0]);
  context.fixture.destroy();
}

it('keeps a failed Share request visible and retries the original message once',
  retriesTheSameShareRequest);
