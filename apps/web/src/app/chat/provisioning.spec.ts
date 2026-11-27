import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ChatRow, ServerMessage } from '@opencrane/protocol';
import { z } from 'zod';
import { ChatSession } from './chat-session';
import { Workspace } from './workspace';
import { WebSocketService } from '../core/websocket.service';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';
import { deferredReply } from '../../../test/support/deferred-reply';

let chat: ChatSession;
let socket: SocketLike;
let requests: string[];
let sent = vi.fn();
let closed = vi.fn();
const socketProvider = { provide: SOCKET_FACTORY, useValue: createSocket };
const identity = { authenticated: true, user: { name: 'Alex' } };

function createSocket(): SocketLike {
  sent = vi.fn();
  closed = vi.fn();
  socket = { readyState: 1, onopen: null, onmessage: null, onclose: null,
    onerror: null, send: sent, close: closed };
  return socket;
}

function requestPath(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function fetchFixture(input: RequestInfo | URL): Promise<Response> {
  const path = requestPath(input);
  requests.push(path);
  let body: unknown = { rows: [] };
  if (path === '/api/chat') body = { memberId: 'me', assistantId: null, role: 'owner' };
  if (path === '/auth/me') body = identity;
  return Promise.resolve(new Response(JSON.stringify(body)));
}

async function setup(): Promise<void> {
  history.replaceState({}, '', '/workspace');
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFixture);
  TestBed.configureTestingModule({ providers: [ChatSession, socketProvider] });
  chat = TestBed.inject(ChatSession);
  await chat.load();
  TestBed.tick();
}

function assignment(memberId = 'me'): void {
  const message = { type: 'context', topic: 'chat-context',
    data: { memberId, assistantId: 'personal', role: 'owner' } };
  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  TestBed.tick();
}

function openAssignmentSocket(): void {
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  expect(sent).toHaveBeenCalledWith(JSON.stringify({
    type: 'subscribe', topic: 'chat-context',
  }));
}

function subscribesToOwnAssignment(): void {
  const service = TestBed.inject(WebSocketService);
  expect(service.state()).toBe('connecting');
  openAssignmentSocket();
  assignment();
  expect(chat.selectedAssistantId()).toBe('personal');
  expect(chat.role()).toBe('owner');
  expect(chat.selected()).toBe('');
  expect(requests.filter(isContextRead)).toHaveLength(1);
}

function isContextRead(path: string): boolean {
  return path === '/api/chat';
}

function clearsOnAccessLoss(): void {
  expect(socket).toBeDefined();
  socket.onclose?.(new CloseEvent('close', { code: 1008 }));
  TestBed.tick();
  expect(chat.denied()).toBe(true);
  expect(chat.selectedAssistantId()).toBeNull();
  assignment();
  expect(chat.selectedAssistantId()).toBeNull();
}

function closesOnDestroy(): void {
  expect(socket).toBeDefined();
  chat.ngOnDestroy();
  expect(closed).toHaveBeenCalled();
}

function receivesAssignmentAfterNewDraft(): void {
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  chat.newSession();
  TestBed.tick();
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  assignment();
  expect(chat.selectedAssistantId()).toBe('personal');
  expect(chat.selected()).toBe('');
  expect(chat.denied()).toBe(false);
  expect(requests.filter(isContextRead)).toHaveLength(1);
}

function refusesAnotherMemberAssignment(): void {
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  assignment('another-member');
  expect(chat.memberId()).toBe('me');
  expect(chat.selectedAssistantId()).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  assignment();
  expect(chat.selectedAssistantId()).toBe('personal');
}

function receivesAssignmentWhileConnecting(): void {
  chat.newSession();
  TestBed.tick();
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  assignment();
  expect(chat.selectedAssistantId()).toBe('personal');
}

function loadedWorkspace(): void {
  beforeEach(setup);
  it('subscribes to its own assignment before a first conversation exists', subscribesToOwnAssignment);
  it('clears provisioning on access loss and ignores later socket messages', clearsOnAccessLoss);
  it('closes the provisioning subscription when the page is destroyed', closesOnDestroy);
  it('receives assignment without reload after opening an unassigned draft',
    receivesAssignmentAfterNewDraft);
  it('ignores another member assignment and keeps listening for its own',
    refusesAnotherMemberAssignment);
  it('receives assignment when a new draft opens before the socket connects',
    receivesAssignmentWhileConnecting);
}

describe('personal assignment after workspace load', loadedWorkspace);

function holdIdentityReply() {
  const heldReply = deferredReply();
  function fetchWithHeldIdentity(input: RequestInfo | URL): Promise<Response> {
    if (input === '/auth/me') {
      requests.push(input);
      return heldReply.promise;
    }
    return fetchFixture(input);
  }
  function releaseIdentity(): void {
    heldReply.release(Response.json(identity));
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWithHeldIdentity);
  return releaseIdentity;
}

function pressNewSessionShortcut(modifier: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...modifier }));
}

async function draftDuringFirstLoad(): Promise<void> {
  const releaseIdentity = holdIdentityReply();
  const fixture = mountWorkspace('?initial=1');
  const root = workspaceRoot(fixture);
  try {
    function identityRequested(): void {
      expect(requests).toContain('/auth/me');
    }
    await vi.waitFor(identityRequested);
    const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
    newSession.click();
    pressNewSessionShortcut({ ctrlKey: true });
    pressNewSessionShortcut({ metaKey: true });
    expect(location.search).toBe('?initial=1');
    expect(newSession.disabled).toBe(true);

    releaseIdentity();
    function readyForDraft(): void {
      fixture.detectChanges();
      expect(newSession.disabled).toBe(false);
    }
    await vi.waitFor(readyForDraft);
    newSession.click();
    expect(location.search).toBe('');
    openAssignmentSocket();
    assignment();
    fixture.detectChanges();
    expect(root.querySelector<HTMLTextAreaElement>('textarea#message')!.disabled).toBe(false);
    expect(requests.filter(isContextRead)).toHaveLength(1);
  } finally {
    releaseIdentity();
    fixture.destroy();
    vi.unstubAllGlobals();
  }
}

it('waits for identity before opening a draft, then receives its live assignment',
  draftDuringFirstLoad);

const latestSession = {
  conversationId: 'latest', assistantId: 'personal', createdBy: 'me',
  mode: 'agent_session', title: 'Latest chat', createdAt: '2026-10-04T13:00:00Z',
};
const requestedSession = {
  ...latestSession, conversationId: 'requested', title: 'Requested chat',
};

function mountWorkspace(search: string): ComponentFixture<Workspace> {
  vi.stubGlobal('innerWidth', 1280);
  history.replaceState({}, '', `/workspace${search}`);
  requests = [];
  TestBed.configureTestingModule({ providers: [socketProvider] });
  const fixture = TestBed.createComponent(Workspace);
  fixture.detectChanges();
  const searchDialog = workspaceRoot(fixture).querySelector('dialog.search-dialog');
  if (!searchDialog) throw new Error('Missing workspace search dialog');
  Object.defineProperty(searchDialog, 'close', { value: closeSearchDialog });
  return fixture;
}

function closeSearchDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
}

function workspaceRoot(fixture: ComponentFixture<Workspace>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing workspace root');
  return root;
}

function savedSessionReply(path: string): Response | undefined {
  if (path.startsWith('/api/conversations/')) {
    return Response.json({ rows: [], generation: 1, position: 0, computerState: 'ready' });
  }
  return undefined;
}

async function settlesRetryAfterSelectingSavedSession(): Promise<void> {
  let identityReads = 0;
  const heldIdentity = deferredReply();

  function read(input: RequestInfo | URL): Promise<Response> {
    const path = requestPath(input);
    if (path === '/auth/me') {
      identityReads += 1;
      if (identityReads === 2) return heldIdentity.promise;
    }
    if (path === '/api/conversations') {
      return Promise.resolve(Response.json({ rows: [latestSession] }));
    }
    if (path.startsWith('/api/conversations?')) {
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    const saved = savedSessionReply(path);
    return saved ? Promise.resolve(saved) : fetchFixture(input);
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  const loads = vi.spyOn(ChatSession.prototype, 'load');
  const fixture = mountWorkspace('?conversation=requested');
  const root = workspaceRoot(fixture);
  try {
    await loads.mock.results[0]!.value;
    fixture.detectChanges();
    expect(location.search).toBe('?conversation=requested');
    const retry = root.querySelector<HTMLButtonElement>('.error button')!;
    expect(retry.textContent?.trim()).toBe('Retry');
    retry.click();

    function retryIsWaitingForIdentity(): void {
      fixture.detectChanges();
      expect(identityReads).toBe(2);
      expect(root.querySelector('.rail-loading')).not.toBeNull();
    }
    await vi.waitFor(retryIsWaitingForIdentity);
    const savedSession = root.querySelector<HTMLButtonElement>('button.session-row')!;
    savedSession.click();

    function savedSessionIsOpen(): void {
      fixture.detectChanges();
      expect(location.search).toBe('?conversation=latest');
      expect(savedSession.getAttribute('aria-current')).toBe('page');
      expect(root.querySelector('.skeleton')).toBeNull();
    }
    await vi.waitFor(savedSessionIsOpen);
    heldIdentity.release(Response.json(identity));
    await loads.mock.results[1]!.value;
    fixture.detectChanges();
    expect(location.search).toBe('?conversation=latest');
    expect(root.querySelector('.rail-loading')).toBeNull();

    const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
    expect(newSession.disabled).toBe(false);
    pressNewSessionShortcut({ ctrlKey: true });
    expect(location.search).toBe('');
    savedSession.click();
    await vi.waitFor(savedSessionIsOpen);
    newSession.click();
    expect(location.search).toBe('');
  } finally {
    heldIdentity.release(Response.json(identity));
    fixture.destroy();
    loads.mockRestore();
    vi.unstubAllGlobals();
  }
}

async function keepsSavedLinkUntilFirstSuccessfulList(): Promise<void> {
  let listReads = 0;
  function read(input: RequestInfo | URL): Promise<Response> {
    const path = requestPath(input);
    if (path === '/api/conversations') {
      listReads += 1;
      if (listReads === 1) return Promise.resolve(new Response(null, { status: 503 }));
      return Promise.resolve(Response.json({ rows: [latestSession, requestedSession] }));
    }
    const saved = savedSessionReply(path);
    return saved ? Promise.resolve(saved) : fetchFixture(input);
  }

  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  const loads = vi.spyOn(ChatSession.prototype, 'load');
  const fixture = mountWorkspace('?conversation=requested');
  const root = workspaceRoot(fixture);
  try {
    await loads.mock.results[0]!.value;
    fixture.detectChanges();
    expect(requests).toContain('/auth/me');
    expect(listReads).toBe(1);
    expect(root.querySelector('.retry-countdown')?.textContent).toContain('6s');
    const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
    const askAgent = root.querySelector<HTMLButtonElement>('button.ask')!;
    expect.soft(newSession.disabled).toBe(true);
    expect.soft(askAgent.disabled).toBe(true);
    newSession.click();
    expect.soft(location.search).toBe('?conversation=requested');
    askAgent.click();
    expect.soft(location.search).toBe('?conversation=requested');
    pressNewSessionShortcut({ ctrlKey: true });
    expect.soft(location.search).toBe('?conversation=requested');
    pressNewSessionShortcut({ metaKey: true });
    expect.soft(location.search).toBe('?conversation=requested');
    expect(root.querySelector<HTMLTextAreaElement>('textarea#message')?.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(6000);
    await loads.mock.results[1]!.value;
    fixture.detectChanges();
    expect(listReads).toBe(2);
    expect(location.search).toBe('?conversation=requested');
    expect(root.querySelector('.session-row[aria-current="page"]')?.textContent)
      .toContain('Requested chat');
    expect(newSession.disabled).toBe(false);
    expect(askAgent.disabled).toBe(false);
  } finally {
    fixture.destroy();
    loads.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

it('settles the rail after selecting a saved session during Retry',
  settlesRetryAfterSelectingSavedSession);
it('preserves the saved link and refuses drafts until the first successful list read',
  keepsSavedLinkUntilFirstSuccessfulList);

const createCommand = z.object({ conversationId: z.string() });
const messageCommand = z.object({ id: z.string() });
const draftPrompt = 'Send from the draft';

function holdSavedTranscript() {
  const held = deferredReply();
  const state = { historyRequested: false, conversationId: '', messageId: '' };
  const conversations = [requestedSession];

  function read(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = requestPath(input);
    if (path === '/api/conversations/requested/messages?tail=50') {
      state.historyRequested = true;
      return held.promise;
    }
    if (path === '/api/conversations') {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const command = createCommand.parse(JSON.parse(init.body));
        state.conversationId = command.conversationId;
        conversations.push({ ...requestedSession, conversationId: state.conversationId });
        return Promise.resolve(Response.json({ status: 'appended' }));
      }
      return Promise.resolve(Response.json({ rows: conversations }));
    }
    if (path.endsWith('/messages') && init?.method === 'POST' && typeof init.body === 'string') {
      const command = messageCommand.parse(JSON.parse(init.body));
      state.messageId = command.id;
      return Promise.resolve(Response.json({ status: 'appended' }));
    }
    return fetchFixture(input);
  }

  function release(): void {
    held.release(Response.json({ rows: [], position: 0, generation: 1, computerState: 'ready' }));
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  return { state, release };
}

function sendConversationFrame(message: ServerMessage): void {
  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
}

function sendReply(conversationId: string, turnId: string): void {
  const feed = { version: 1, topic: 'conversation', conversationId, generation: 1 } as const;
  const time = '2026-10-04T13:01:00Z';
  const message: ChatRow = { id: turnId, position: 1, type: 'message.posted', time,
    data: { authorId: 'me', text: draftPrompt } };
  const reply: ChatRow = { id: 'reply', position: 2, type: 'agent.message_completed', time,
    data: { turnId, text: 'A new draft reply' } };
  const end: ChatRow = { id: 'end', position: 3, type: 'agent.turn_completed', time,
    data: { turnId } };
  sendConversationFrame({ ...feed, type: 'event', position: 1, row: message });
  sendConversationFrame({ ...feed, type: 'ready', position: 1 });
  sendConversationFrame({ ...feed, type: 'event', position: 2, row: reply });
  sendConversationFrame({ ...feed, type: 'event', position: 3, row: end });
}

async function opensDraftWhileSavedTranscriptLoads(): Promise<void> {
  const saved = holdSavedTranscript();
  const loads = vi.spyOn(ChatSession.prototype, 'load');
  const fixture = mountWorkspace('?conversation=requested');
  const root = workspaceRoot(fixture);
  try {
    const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
    function savedTranscriptIsPending(): void {
      fixture.detectChanges();
      expect(saved.state.historyRequested).toBe(true);
      expect(root.querySelector('.skeleton')).not.toBeNull();
      expect(newSession.disabled).toBe(false);
    }
    await vi.waitFor(savedTranscriptIsPending);
    newSession.click();
    expect(location.search).toBe('');
    openAssignmentSocket();
    assignment();
    saved.release();
    await loads.mock.results[0]!.value;
    fixture.detectChanges();

    const composer = root.querySelector<HTMLTextAreaElement>('textarea#message')!;
    expect(composer.disabled).toBe(false);
    composer.value = draftPrompt;
    composer.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click();

    function sentDraftIsVisible(): void {
      fixture.detectChanges();
      expect(saved.state.messageId).not.toBe('');
      expect(root.textContent).toContain(draftPrompt);
    }
    await vi.waitFor(sentDraftIsVisible);
    socket.onopen?.(new Event('open'));
    fixture.detectChanges();
    expect(sent).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', topic: 'conversation',
      conversationId: saved.state.conversationId, since: 0, generation: 0 }));
    sendReply(saved.state.conversationId, saved.state.messageId);
    fixture.detectChanges();
    const agentReply = root.querySelector('article[aria-label="Agent reply"]');
    expect(agentReply?.textContent).toContain('A new draft reply');
    expect(agentReply?.textContent).toContain('Done');
  } finally {
    saved.release();
    fixture.destroy();
    loads.mockRestore();
    vi.unstubAllGlobals();
  }
}

it('shows the live reply after opening a draft before the saved transcript loads',
  opensDraftWhileSavedTranscriptLoads);

async function showsAccessChangedForSignedInNonMember(): Promise<void> {
  function read(input: RequestInfo | URL): Promise<Response> {
    if (requestPath(input) === '/api/chat') {
      return Promise.resolve(Response.json({ status: 'refused' }, { status: 403 }));
    }
    return fetchFixture(input);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  const loads = vi.spyOn(ChatSession.prototype, 'load');
  const fixture = mountWorkspace('');
  try {
    await loads.mock.results[0]!.value;
    fixture.detectChanges();
    const root = workspaceRoot(fixture);
    expect(root.textContent).toContain('Conversation access changed');
    const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
    expect(newSession.disabled).toBe(true);
    expect(root.textContent).toContain('You no longer have access');
  } finally {
    fixture.destroy();
    loads.mockRestore();
    vi.unstubAllGlobals();
  }
}

it('shows access changed and disables New session for a signed-in non-member',
  showsAccessChangedForSignedInNonMember);
