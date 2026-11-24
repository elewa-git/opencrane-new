import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ChatSession } from './chat-session';
import { Workspace } from './workspace';
import { WebSocketService } from '../core/websocket.service';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

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

function fetchFixture(input: RequestInfo | URL): Promise<Response> {
  const path = input instanceof Request ? input.url : String(input);
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

describe('personal assignment after workspace load', function loadedWorkspace() {
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
});

function holdIdentityReply() {
  let release!: (response: Response) => void;
  const heldReply = new Promise<Response>(function captureRelease(resolve) {
    release = resolve;
  });
  function fetchWithHeldIdentity(input: RequestInfo | URL): Promise<Response> {
    if (input === '/auth/me') {
      requests.push(input);
      return heldReply;
    }
    return fetchFixture(input);
  }
  function releaseIdentity(): void {
    release(Response.json(identity));
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWithHeldIdentity);
  return releaseIdentity;
}

function pressNewSessionShortcut(modifier: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ...modifier }));
}

it('waits for identity before opening a draft, then receives its live assignment',
  async function draftDuringFirstLoad() {
    vi.stubGlobal('innerWidth', 1280);
    history.replaceState({}, '', '/workspace?initial=1');
    requests = [];
    const releaseIdentity = holdIdentityReply();
    TestBed.configureTestingModule({ providers: [socketProvider] });
    const fixture = TestBed.createComponent(Workspace);
    try {
      fixture.detectChanges();
      await vi.waitFor(function identityRequested() {
        expect(requests).toContain('/auth/me');
      });
      const root: unknown = fixture.nativeElement;
      if (!(root instanceof HTMLElement)) throw new Error('Missing workspace root');
      const newSession = root.querySelector<HTMLButtonElement>('button.new-session')!;
      newSession.click();
      pressNewSessionShortcut({ ctrlKey: true });
      pressNewSessionShortcut({ metaKey: true });
      expect(location.search).toBe('?initial=1');
      expect(newSession.disabled).toBe(true);

      releaseIdentity();
      await vi.waitFor(function readyForDraft() {
        fixture.detectChanges();
        expect(newSession.disabled).toBe(false);
      });
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
  });

const latestSession = {
  conversationId: 'latest', assistantId: 'personal', createdBy: 'me',
  mode: 'agent_session', title: 'Latest chat', createdAt: '2026-10-04T13:00:00Z',
};
const requestedSession = {
  ...latestSession, conversationId: 'requested', title: 'Requested chat',
};

function mountSavedLink(): ComponentFixture<Workspace> {
  vi.stubGlobal('innerWidth', 1280);
  history.replaceState({}, '', '/workspace?conversation=requested');
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
  let releaseIdentity!: (response: Response) => void;
  function holdIdentity(resolve: (response: Response) => void): void {
    releaseIdentity = resolve;
  }
  const heldIdentity = new Promise<Response>(holdIdentity);

  function read(input: RequestInfo | URL): Promise<Response> {
    const path = String(input);
    if (path === '/auth/me' && ++identityReads === 2) return heldIdentity;
    if (path === '/api/conversations') return Promise.resolve(Response.json({ rows: [latestSession] }));
    if (path.startsWith('/api/conversations?')) return Promise.resolve(new Response(null, { status: 503 }));
    const saved = savedSessionReply(path);
    return saved ? Promise.resolve(saved) : fetchFixture(input);
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  const loads = vi.spyOn(ChatSession.prototype, 'load');
  const fixture = mountSavedLink();
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
    releaseIdentity(Response.json(identity));
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
    releaseIdentity(Response.json(identity));
    fixture.destroy();
    loads.mockRestore();
    vi.unstubAllGlobals();
  }
}

async function keepsSavedLinkUntilFirstSuccessfulList(): Promise<void> {
  let listReads = 0;
  function read(input: RequestInfo | URL): Promise<Response> {
    const path = String(input);
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
  const fixture = mountSavedLink();
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
    pressNewSessionShortcut({ ctrlKey: true });
    expect.soft(location.search).toBe('?conversation=requested');
    pressNewSessionShortcut({ metaKey: true });
    expect.soft(location.search).toBe('?conversation=requested');
    newSession.click();
    askAgent.click();
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
