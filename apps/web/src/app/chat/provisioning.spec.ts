import { TestBed } from '@angular/core/testing';
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
  if (path === '/auth/me') body = { authenticated: true, user: { name: 'Alex' } };
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

function subscribesToOwnAssignment(): void {
  const service = TestBed.inject(WebSocketService);
  expect(service.state()).toBe('connecting');
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  expect(sent).toHaveBeenCalledWith(JSON.stringify({
    type: 'subscribe', topic: 'chat-context',
  }));
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
  const identity = new Promise<Response>(function captureRelease(resolve) {
    release = resolve;
  });
  function fetchWithHeldIdentity(input: RequestInfo | URL): Promise<Response> {
    if (input === '/auth/me') {
      requests.push(input);
      return identity;
    }
    return fetchFixture(input);
  }
  function releaseIdentity(): void {
    release(new Response('{"authenticated":true,"user":{"name":"Alex"}}'));
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
      const root: HTMLElement = fixture.nativeElement;
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
      socket.onopen?.(new Event('open'));
      TestBed.tick();
      expect(sent).toHaveBeenCalledWith(JSON.stringify({
        type: 'subscribe', topic: 'chat-context',
      }));
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
