import { TestBed } from '@angular/core/testing';
import { ChatSession } from './chat-session';
import { WebSocketService } from '../core/websocket.service';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

let chat: ChatSession;
let socket: SocketLike;
let requests: string[];
let sent = vi.fn();
let closed = vi.fn();

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
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  TestBed.configureTestingModule({ providers: [ChatSession, provider] });
  chat = TestBed.inject(ChatSession);
  await chat.load();
  TestBed.tick();
}
beforeEach(setup);

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
it('subscribes to its own assignment before a first conversation exists', subscribesToOwnAssignment);

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
it('clears provisioning on access loss and ignores later socket messages', clearsOnAccessLoss);

function closesOnDestroy(): void {
  expect(socket).toBeDefined();
  chat.ngOnDestroy();
  expect(closed).toHaveBeenCalled();
}
it('closes the provisioning subscription when the page is destroyed', closesOnDestroy);

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
it('receives assignment without reload after opening an unassigned draft',
  receivesAssignmentAfterNewDraft);

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
it('ignores another member assignment and keeps listening for its own',
  refusesAnotherMemberAssignment);

function receivesAssignmentWhileConnecting(): void {
  chat.newSession();
  TestBed.tick();
  socket.onopen?.(new Event('open'));
  TestBed.tick();
  assignment();
  expect(chat.selectedAssistantId()).toBe('personal');
}
it('receives assignment when a new draft opens before the socket connects',
  receivesAssignmentWhileConnecting);
