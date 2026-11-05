import { TestBed } from '@angular/core/testing';
import type { ChatRow } from '@opencrane/protocol';
import { ChatSession } from './chat-session';
import { WebSocketService } from '../core/websocket.service';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

const identity = { version: 1, topic: 'conversation', conversationId: 'chat',
  turnId: 'turn', threadId: 'thread', generation: 7, inputGeneration: 'input' };
const reply = { ...identity, type: 'private_reply', data: { text: 'Synthetic reply', turnId: 'turn' } };
const clearance = { ...identity, type: 'private_output_cleared' };
let sockets: SocketLike[];
let chat: ChatSession;
let service: WebSocketService;
let position: number;
let feedRows: ChatRow[];
let status: number;
let posts: number;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
async function fetchFixture(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const path = String(input);
  if (options?.method === 'POST') {
    posts += 1;
    return response({ status: 'appended' });
  }
  if (path === '/api/chat') return response({ memberId: 'me', assistantId: 'assistant' });
  if (path === '/auth/me') return response({ authenticated: true, user: { name: 'Alex' } });
  if (path === '/api/conversations') {
    return response({ rows: [{ conversationId: 'chat', assistantId: 'assistant',
      mode: 'agent_session', createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' }] });
  }
  return response({ rows: feedRows, position, generation: 2, computerState: 'ready' });
}
function createSocket(): SocketLike {
  const socket: SocketLike = { readyState: 1, onopen: null, onmessage: null,
    onclose: null, onerror: null, send: vi.fn(), close: vi.fn() };
  sockets.push(socket);
  return socket;
}
function send(frame: unknown): void {
  sockets.at(-1)?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
}
function row(type: string, data: ChatRow['data'] = { turnId: 'turn' }): ChatRow {
  position += 1;
  return { id: `row-${position}`, position, type, data, time: '2026-11-05T00:00:00Z' };
}
function event(type: string, data?: ChatRow['data']): void {
  const saved = row(type, data);
  send({ version: 1, topic: 'conversation', conversationId: 'chat', type: 'event',
    position, generation: 2, row: saved });
}
async function setup(): Promise<void> {
  history.replaceState({}, '', '/workspace?conversation=chat');
  sockets = []; feedRows = []; position = 0; status = 200; posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFixture);
  vi.spyOn(console, 'warn').mockImplementation(ignoreWarning);
  TestBed.configureTestingModule({ providers: [ChatSession,
    { provide: SOCKET_FACTORY, useValue: createSocket }] });
  chat = TestBed.inject(ChatSession);
  service = TestBed.inject(WebSocketService);
  await chat.load();
  sockets.at(-1)?.onopen?.(new Event('open'));
  TestBed.tick();
  send({ version: 1, topic: 'conversation', conversationId: 'chat', type: 'ready',
    position, generation: 2 });
  event('agent.turn_started');
}
function ignoreWarning(): void { /* Expected invalid frames carry no logged content. */ }
beforeEach(setup);

function deliverOnce(): void {
  const received = vi.fn();
  const subscription = service.received.subscribe(received);
  send(reply);
  expect(chat.privateReply()).toEqual(reply);
  expect(service.messages()).not.toContainEqual(reply);
  expect(service.lastMessage()).not.toEqual(reply);
  expect(received).not.toHaveBeenCalled();
  expect(JSON.stringify(chat.rows())).not.toContain('Synthetic reply');
  expect(JSON.stringify(chat.conversations())).not.toContain('Synthetic reply');
  expect(chat.announcement()).not.toContain('Synthetic reply');
  expect(localStorage.length + sessionStorage.length).toBe(0);
  send({ ...reply, data: { text: 'Duplicate', turnId: 'turn' } });
  expect(chat.privateReply()).toEqual(reply);
  subscription.unsubscribe();
}
it('delivers once outside history, rows, titles, announcements and browser storage', deliverOnce);

function refuseFrame(change: Record<string, unknown>): void {
  send({ ...reply, ...change });
  expect(chat.privateReply()).toBeNull();
}
it.each([{ conversationId: 'other' }, { turnId: 'other' }, { generation: 0 },
  { data: { text: 'Synthetic reply', turnId: 'other' } }, { position: 9 },
  { inputGeneration: '' }, { threadId: '' }])('refuses invalid or unrelated frames %j', refuseFrame);

function preserveForOtherClearance(change: Record<string, unknown>): void {
  send(reply);
  send({ ...clearance, ...change });
  expect(chat.privateReply()).toEqual(reply);
  send(clearance);
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it.each([{ conversationId: 'other' }, { turnId: 'other' }, { threadId: 'other' },
  { generation: 2 }, { inputGeneration: 'other' }])(
  'clears only the exact identity, independent of projection generation %j',
  preserveForOtherClearance);

function clearanceBeforeReply(): void {
  send(clearance);
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('cannot restore text after clearance arrives first', clearanceBeforeReply);

function preserveForOrdinaryEvent(type: string): void {
  send(reply);
  event(type);
  expect(chat.privateReply()).toEqual(reply);
}
it.each(['message.posted', 'file.uploaded', 'memory.corrected', 'agent.output_lost',
  'agent.turn_completed'])('retains a live reply after %s', preserveForOrdinaryEvent);

function outputLostBeforeReply(): void {
  event('agent.output_lost');
  send(reply);
  expect(chat.privateReply()).toEqual(reply);
  send(clearance);
  event('agent.output_lost');
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('output loss neither suppresses live delivery nor restores cleared text', outputLostBeforeReply);

function clearForTerminal(type: string): void {
  send(reply);
  event(type);
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it.each(['agent.turn_stop_requested', 'agent.turn_failed', 'conversation.closed'])(
  'clears and refuses late delivery after %s', clearForTerminal);

async function clearOnLifecycle(action: string): Promise<void> {
  send(reply);
  const stale = sockets.at(-1)?.onmessage;
  if (action === 'Stop') await chat.stop();
  if (action === 'disconnect') service.disconnect();
  if (action === 'replacement') service.connect();
  if (action === 'loss') sockets.at(-1)?.onclose?.(new CloseEvent('close', { code: 1013 }));
  if (action === 'access') sockets.at(-1)?.onclose?.(new CloseEvent('close', { code: 1008 }));
  if (action === 'navigation') chat.newSession();
  if (action === 'destroy') chat.ngOnDestroy();
  if (action === 'resync') {
    send({ version: 1, topic: 'conversation', conversationId: 'chat', type: 'resync',
      position, generation: 3 });
  }
  expect(chat.privateReply()).toBeNull();
  stale?.(new MessageEvent('message', { data: JSON.stringify(reply) }));
  expect(chat.privateReply()).toBeNull();
}
it.each(['Stop', 'disconnect', 'replacement', 'loss', 'access', 'navigation', 'destroy', 'resync'])(
  'clears synchronously on %s and ignores late frames', clearOnLifecycle);

async function refusedRead(code: number): Promise<void> {
  send(reply);
  status = code;
  await chat.refresh();
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it.each([401, 403])('clears after a refused HTTP read (%i)', refusedRead);

function completionBeforeReply(): void {
  event('agent.turn_completed');
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('refuses a first reply after completion', completionBeforeReply);

async function reconnectDoesNotReplay(): Promise<void> {
  send(reply);
  service.connect();
  sockets.at(-1)?.onopen?.(new Event('open'));
  TestBed.tick();
  event('agent.turn_started');
  send(reply);
  expect(chat.privateReply()).toBeNull();
  expect(posts).toBe(0);
  await chat.select('chat');
  expect(chat.privateReply()).toBeNull();
}
it('does not revive old turns from catch-up after reconnect or reload', reconnectDoesNotReplay);

function newTurn(): void {
  send(reply);
  event('agent.turn_started', { turnId: 'next' });
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
  send({ ...reply, turnId: 'next', inputGeneration: 'next-input',
    data: { turnId: 'next', text: 'Next synthetic reply' } });
  expect(chat.privateReply()?.turnId).toBe('next');
}
it('replaces the previous turn without accepting its late reply', newTurn);

function excludeShared(): void {
  chat.conversations.set([{ conversationId: 'chat', mode: 'agent_session',
    assistantId: 'team-assistant', assistantKind: 'team', payingGroupId: 'team',
    createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' }]);
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('excludes shared assistant sessions', excludeShared);
