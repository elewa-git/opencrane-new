import { TestBed } from '@angular/core/testing';
import type { ChatRow } from '@opencrane/protocol';
import { ChatSession } from './chat-session';
import { WebSocketService } from '../core/websocket.service';
import { SOCKET_FACTORY, type SocketLike } from '../core/socket-factory';

const identity = { version: 1, topic: 'conversation', conversationId: 'chat',
  turnId: 'turn', threadId: 'thread', generation: 7, inputGeneration: 'input' };
const reply = { ...identity, type: 'private_reply', data: { text: 'Synthetic reply', turnId: 'turn' } };
const nextTurn = { turnId: 'next' };
const nextReply = { ...reply, turnId: 'next', inputGeneration: 'next-input',
  data: { turnId: 'next', text: 'Next synthetic reply' } };
const duplicateReply = { ...reply, data: { text: 'Duplicate', turnId: 'turn' } };
const clearance = { ...identity, type: 'private_output_cleared' };
let sockets: SocketLike[];
let chat: ChatSession;
let service: WebSocketService;
let position: number;
let feedRows: ChatRow[];
let status: number;
let posts: number;
let heldFeed: Promise<Response> | undefined;
let authenticated: boolean;
let heldAuthentication: Promise<Response> | undefined;

function response(body: unknown): Promise<Response> {
  const options = { status };
  return Promise.resolve(new Response(JSON.stringify(body), options));
}
function fetchFixture(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const path = input instanceof Request ? input.url : String(input);
  if (options?.method === 'POST') {
    posts += 1;
    const receipt = { status: 'appended' };
    return response(receipt);
  }
  if (path === '/api/chat') {
    const context = { memberId: 'me', assistantId: 'assistant' };
    return response(context);
  }
  if (path === '/auth/me') {
    if (heldAuthentication) return heldAuthentication;
    const authentication = { authenticated, user: { name: 'Alex' } };
    return response(authentication);
  }
  if (path === '/api/conversations') {
    const conversation = { conversationId: 'chat', assistantId: 'assistant',
      mode: 'agent_session', createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' };
    const list = { rows: [conversation] };
    return response(list);
  }
  if (heldFeed) return heldFeed;
  const feed = { rows: feedRows, position, generation: 2, computerState: 'ready' };
  return response(feed);
}
function createSocket(): SocketLike {
  const socket: SocketLike = { readyState: 1, onopen: null, onmessage: null,
    onclose: null, onerror: null, send: vi.fn(), close: vi.fn() };
  sockets.push(socket);
  return socket;
}
function send(frame: unknown): void {
  const options = { data: JSON.stringify(frame) };
  sockets.at(-1)?.onmessage?.(new MessageEvent('message', options));
}
function row(type: string, data: ChatRow['data'] = { turnId: 'turn' }): ChatRow {
  position += 1;
  return { id: `row-${position}`, position, type, data, time: '2026-11-05T00:00:00Z' };
}
function event(type: string, data?: ChatRow['data']): void {
  const saved = row(type, data);
  const frame = { version: 1, topic: 'conversation', conversationId: 'chat', type: 'event',
    position, generation: 2, row: saved };
  send(frame);
}
async function setup(): Promise<void> {
  history.replaceState({}, '', '/workspace?conversation=chat');
  sockets = [];
  feedRows = [];
  position = 0;
  status = 200;
  posts = 0;
  heldFeed = undefined;
  authenticated = true;
  heldAuthentication = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFixture);
  vi.spyOn(console, 'warn').mockImplementation(ignoreWarning);
  const socketProvider = { provide: SOCKET_FACTORY, useValue: createSocket };
  const configuration = { providers: [ChatSession, socketProvider] };
  TestBed.configureTestingModule(configuration);
  chat = TestBed.inject(ChatSession);
  service = TestBed.inject(WebSocketService);
  await chat.load();
  sockets.at(-1)?.onopen?.(new Event('open'));
  TestBed.tick();
  const ready = { version: 1, topic: 'conversation', conversationId: 'chat', type: 'ready',
    position, generation: 2 };
  send(ready);
  event('agent.turn_started');
}
function ignoreWarning(): void {
  // Keep expected invalid-frame warnings out of the test output.
}
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
  send(duplicateReply);
  expect(chat.privateReply()).toEqual(reply);
  subscription.unsubscribe();
}
it('delivers once outside history, rows, titles, announcements and browser storage', deliverOnce);

function refuseFrame(change: Record<string, unknown>): void {
  const changedReply = { ...reply, ...change };
  send(changedReply);
  expect(chat.privateReply()).toBeNull();
}
const invalidFrames = [{ conversationId: 'other' }, { turnId: 'other' }, { generation: 0 },
  { data: { text: 'Synthetic reply', turnId: 'other' } }, { position: 9 },
  { inputGeneration: '' }, { threadId: '' }];
it.each(invalidFrames)('refuses invalid or unrelated frames %j', refuseFrame);

function preserveForOtherClearance(change: Record<string, unknown>): void {
  send(reply);
  const changedClearance = { ...clearance, ...change };
  send(changedClearance);
  expect(chat.privateReply()).toEqual(reply);
  send(clearance);
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
const otherClearances = [{ conversationId: 'other' }, { turnId: 'other' }, { threadId: 'other' },
  { generation: 2 }, { inputGeneration: 'other' }];
it.each(otherClearances)(
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
  if (action === 'loss' || action === 'access') {
    const code = action === 'access' ? 1008 : 1013;
    const closeOptions = { code };
    sockets.at(-1)?.onclose?.(new CloseEvent('close', closeOptions));
  }
  if (action === 'navigation') chat.newSession();
  if (action === 'destroy') chat.ngOnDestroy();
  if (action === 'resync') {
    const resync = { version: 1, topic: 'conversation', conversationId: 'chat', type: 'resync',
      position, generation: 3 };
    send(resync);
  }
  expect(chat.privateReply()).toBeNull();
  const options = { data: JSON.stringify(reply) };
  stale?.(new MessageEvent('message', options));
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
  event('agent.turn_started', nextTurn);
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
  send(nextReply);
  expect(chat.privateReply()?.turnId).toBe('next');
}
it('replaces the previous turn without accepting its late reply', newTurn);

function excludeShared(): void {
  const conversations = [{ conversationId: 'chat', mode: 'agent_session' as const,
    assistantId: 'team-assistant', assistantKind: 'team' as const, payingGroupId: 'team',
    createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' }];
  chat.conversations.set(conversations);
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('excludes shared assistant sessions', excludeShared);

async function lateReadCannotRestore(): Promise<void> {
  send(reply);
  let finish!: (response: Response) => void;
  function hold(resolve: (response: Response) => void): void {
    finish = resolve;
  }
  heldFeed = new Promise(hold);
  const refreshing = chat.refresh();
  send(clearance);
  const data = { rows: [row('agent.turn_started')], position, generation: 2,
    computerState: 'ready' };
  finish(new Response(JSON.stringify(data)));
  await refreshing;
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('late HTTP history cannot restore a cleared reply', lateReadCannotRestore);

async function projectionReplacement(): Promise<void> {
  send(reply);
  const data = { rows: [], position: 0, generation: 3, computerState: 'ready' };
  heldFeed = Promise.resolve(new Response(JSON.stringify(data)));
  await chat.refresh();
  expect(chat.privateReply()).toBeNull();
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('a replacement HTTP projection clears a reply', projectionReplacement);

function directSession(): void {
  const conversations = [{ conversationId: 'chat', mode: 'direct' as const,
    participantIds: ['me', 'colleague'], createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' }];
  chat.conversations.set(conversations);
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('excludes direct sessions', directSession);

async function uploadRetainsReply(): Promise<void> {
  send(reply);
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'setRequestHeader').mockImplementation(ignoreRequest);
  vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(completeUpload);
  const connections = sockets.length;
  await chat.upload(new File(['fixture'], 'fixture.txt'));
  expect(chat.uploadBatch.pendingDelivery()).toBe('file');
  expect(sockets).toHaveLength(connections);
  expect(chat.privateReply()).toEqual(reply);
}
it('uploading retains the reply and the current socket', uploadRetainsReply);

function ignoreRequest(): void {
  // Keep this browser-state check away from the network.
}
function completeUpload(this: XMLHttpRequest): void {
  const savedStatus = { value: 201 };
  const file = { fileId: 'file' };
  const savedBody = { value: JSON.stringify(file) };
  Object.defineProperty(this, 'status', savedStatus);
  Object.defineProperty(this, 'responseText', savedBody);
  this.onload?.(new ProgressEvent('load'));
}

async function historyReplacesTurn(): Promise<void> {
  send(reply);
  feedRows = [row('agent.turn_started', nextTurn)];
  await chat.refresh();
  expect(chat.privateReply()).toBeNull();
  const next = { ...reply, turnId: 'next', data: { turnId: 'next', text: 'Next fixture' } };
  send(next);
  expect(chat.privateReply()).toBeNull();
}
it('a replacement turn in HTTP history clears text without enabling delivery', historyReplacesTurn);

async function returningSignedOut(): Promise<void> {
  send(reply);
  expect(chat.privateReply()).toEqual(reply);
  authenticated = false;
  window.dispatchEvent(new Event('focus'));
  function cleared(): void {
    expect(chat.privateReply()).toBeNull();
    expect(service.isConnected()).toBe(false);
  }
  await vi.waitFor(cleared);
  event('agent.turn_started', nextTurn);
  send(nextReply);
  expect(chat.privateReply()).toBeNull();
}
it('clears private output when a returning tab finds its session has ended', returningSignedOut);

async function checkBeforePrivateDelivery(): Promise<void> {
  let finish!: (response: Response) => void;
  function hold(resolve: (response: Response) => void): void {
    finish = resolve;
  }
  heldAuthentication = new Promise(hold);
  window.dispatchEvent(new Event('focus'));
  send(reply);
  expect(chat.privateReply()).toBeNull();
  const signedOut = { authenticated: false, user: null };
  finish(new Response(JSON.stringify(signedOut)));
  function disconnected(): void {
    expect(service.isConnected()).toBe(false);
  }
  await vi.waitFor(disconnected);
  send(reply);
  expect(chat.privateReply()).toBeNull();
}
it('blocks private frames while a returning tab checks its session', checkBeforePrivateDelivery);
