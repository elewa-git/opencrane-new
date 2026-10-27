import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryContextRecordedEventSchema, parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { fixture } from '../../computer/test/bridge-gate-fixture.ts';
import { createLogger } from '@opencrane/observability';
import { assistantProcessor } from '../src/chat/bridge-poll.ts';
import type { AgentSession } from '../src/chat/bridge-conversation.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { invalidateMemoryContext } from '../src/memory/invalidation.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let computer: Awaited<ReturnType<typeof fixture>>;
let link: Awaited<ReturnType<typeof connectBridge>>;
let keys: ReturnType<typeof conversationKeys>;
let processor: ReturnType<typeof assistantProcessor>;
const sessions: AgentSession[] = [];
function forbiddenConnection(): Promise<never> { throw new Error('Must not open a computer'); }
const opening = vi.fn(forbiddenConnection);
const scopeId = memoryScopeId('test', 'person', 'alice');
const binding = { conversationId: 'chat', turnId: 'turn', requesterId: 'alice',
  assistantId: 'assistant', computerId: 'computer', generation: 1,
  threadId: 'thread-1', inputGeneration: '1' };
const prepared = { ...binding, projectionGeneration: 'projection', action: 'prepared',
  delivery: null, callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
  byteCount: 0, hasOmissions: false, reason: 'none' };
async function flush() {
  const pong = once(link.socket, 'pong');
  link.socket.ping();
  await pong;
}
async function append(subject: string, type: string, data: object, id: string = randomUUID()) {
  const event = { id, commandId: id, silo: 'test', subject, type, data,
    source: 'opencrane-server', time: new Date().toISOString(), correlation: {},
    principal: { kind: 'system' as const, id: 'server' } };
  expect(parseEventByType(event).success).toBe(true);
  const expectedSequence = await nats.store.head(subject);
  expect(await nats.store.append({ event, expectedSequence })).toMatchObject({ status: 'appended' });
  return event;
}
async function startTurn(id = 'turn', conversationId = 'chat', requesterId = 'alice',
  threadId = 'thread-1') {
  const frame = { type: 'turn', id, conversationId, requesterId, assistantId: 'assistant',
    executionMode: 'restricted', text: 'Hello', token: 'fixture', expiresAt: Date.now() + 60_000 };
  link.socket.send(JSON.stringify(frame));
  function running() { expect(computer.calls).toContain(`turn/start:${threadId}`); }
  await vi.waitFor(running);
  await flush();
}
async function setup() {
  nats = await natsFixture();
  computer = await fixture(false);
  keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  keys.provision('test', 'chat');
  await append('member-alice', 'member.invited', { memberId: 'alice', invitationId: 'invite',
    email: 'a@example.test', role: 'member', invitedBy: 'owner' });
  await append('member-alice', 'member.joined', { memberId: 'alice', invitationId: 'invite',
    email: 'a@example.test', role: 'member', displayName: 'Alice' });
  await append('assistant-assistant', 'assistant.created', { assistantId: 'assistant',
    ownerId: 'alice', kind: 'personal' });
  await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant',
    computerId: 'computer', sandboxUid: 'sandbox', generation: 1, tokenId: 'token:test' });
  await append('computer-assistant', 'computer.ready', { assistantId: 'assistant',
    computerId: 'computer', generation: 1, podUid: 'pod' });
  await append('conversation-chat', 'conversation.created', { conversationId: 'chat',
    createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session' });
  const encrypted = keys.encrypt('test', 'chat', 'Hello');
  await append('conversation-chat', 'message.posted', { conversationId: 'chat',
    authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted }, 'turn');
  await append('computer-assistant', 'computer.turn_started', { conversationId: 'chat',
    turnId: 'turn', requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    threadId: 'thread-1', task: 'chat_turn', executionMode: 'restricted' });
  computer.socket.terminate();
  await once(computer.socket, 'close');
  const options = { silo: 'test', store: nats.store, keys };
  const input = { url: computer.socket.url, computerId: 'computer',
    assistantId: 'assistant', bearer: 'test' };
  link = await connectBridge(options, input, computer.issuer);
  await startTurn();
  await link.settled();
  expect(link.rejection).toBeUndefined();
  sessions.length = 0;
  sessions.push({ conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session', createdAt: new Date().toISOString(), assistantKind: 'personal' });
  function connectionId() { return 1; }
  function connected() { return link; }
  const watch = { ...options, db: undefined! };
  processor = assistantProcessor(watch, computer.issuer, new Set(), opening,
    connectionId, createLogger('memory-delivery', { level: 'silent' }), connected);
  opening.mockClear();
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['test', scopeId, 'person', 'alice', 'fact', 1]));
  await append(`scope-${scopeId}`, 'memory.written', { schemaVersion: 1, scopeId,
    scopeKind: 'person', ownerId: 'alice', memoryId: 'fact', revision: 1, kind: 'fact',
    pinned: false, expiresAt: null, sources: [], dependsOn: [],
    keyId: `key:${hash.digest('hex')}`, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  await append('conversation-chat', 'agent.memory_context_recorded', prepared);
  const position = await nats.store.head(`scope-${scopeId}`);
  await append('conversation-chat', 'agent.memory_context_recorded', { ...prepared,
    action: 'loaded', delivery: 'initial', byteCount: 50,
    additions: [{ scopeId, memoryId: 'fact', revision: 1 }],
    scopePositions: [{ scopeId, position }] });
}
async function cleanup() {
  vi.restoreAllMocks();
  link?.socket.terminate();
  await link?.settled();
  await computer?.close();
  await nats?.close();
}
beforeEach(setup);
afterEach(cleanup);
async function invalidated(kind: 'corrected' | 'forgotten' = 'forgotten') {
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'fact', revision: 2, expectedRevision: 1 };
  let changed: object = data;
  if (kind === 'corrected') {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(['test', scopeId, 'person', 'alice', 'fact', 2]));
    changed = { ...data, kind: 'fact', pinned: false, expiresAt: null, sources: [], dependsOn: [],
      keyId: `key:${hash.digest('hex')}`, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      supersedes: { memoryId: 'fact', revision: 1 }, reason: 'human' };
  }
  const cause = await append(`scope-${scopeId}`, `memory.${kind}`, changed);
  const options = { silo: 'test', store: nats.store };
  const request = { conversationId: 'chat', turnId: 'turn', threadId: 'thread-1',
    inputGeneration: '1', causeId: cause.id };
  expect(await invalidateMemoryContext(options, request)).toMatchObject({ status: 'invalidated' });
  const rows = await history(nats.store, 'conversation-chat', 'test');
  return memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
}

async function poll() {
  await Promise.all(processor.pollMemory(sessions));
  await flush();
}
function targetInterrupt(call: string) { return call === 'turn/interrupt:thread-1'; }
async function deliversSavedInvalidation(kind: 'corrected' | 'forgotten') {
  await invalidated(kind);
  await poll();
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
  await Promise.all([poll(), poll()]);
  expect(computer.calls.filter(targetInterrupt)).toHaveLength(1);
  expect(computer.grants.has('thread-1')).toBe(false);
}
it.each(['corrected', 'forgotten'] as const)(
  'delivers saved %s invalidation through the recording bridge', deliversSavedInvalidation);
async function retriesSend() {
  await invalidated();
  function fail() { throw new Error('private transport canary'); }
  vi.spyOn(link.socket, 'send').mockImplementationOnce(fail);
  await link.memory.poll('chat');
  expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
  await poll();
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
}
it('retries failed delivery on the next poll without new events', retriesSend);

async function otherTurn(requesterId = 'alice') {
  if (requesterId === 'bob') {
    await append('member-bob', 'member.invited', { memberId: 'bob', invitationId: 'bob',
      email: 'b@example.test', role: 'member', invitedBy: 'owner' });
    await append('member-bob', 'member.joined', { memberId: 'bob', invitationId: 'bob',
      email: 'b@example.test', role: 'member', displayName: 'Bob' });
  }
  keys.provision('test', 'other');
  await append('conversation-other', 'conversation.created', { conversationId: 'other',
    createdBy: requesterId, assistantId: 'assistant', mode: 'agent_session' });
  const encrypted = keys.encrypt('test', 'other', 'Independent question');
  await append('conversation-other', 'message.posted', { conversationId: 'other',
    authorId: requesterId, authorKind: 'human', contentType: 'text', ...encrypted }, 'other-turn');
  await append('computer-assistant', 'computer.turn_started', { conversationId: 'other',
    turnId: 'other-turn', requesterId, assistantId: 'assistant', computerId: 'computer',
    threadId: 'thread-2', task: 'chat_turn', executionMode: 'restricted' });
  await startTurn('other-turn', 'other', requesterId, 'thread-2');
  await link.settled();
  sessions.push({ conversationId: 'other', assistantId: 'assistant', createdBy: requesterId,
    mode: 'agent_session', createdAt: new Date().toISOString(), assistantKind: 'personal' });
}
async function preservesOther(requesterId: string) {
  await otherTurn(requesterId);
  await invalidated();
  await poll();
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
  expect(computer.grants.has('thread-2')).toBe(true);
  expect(computer.calls).not.toContain('turn/interrupt:thread-2');
  expect(opening).not.toHaveBeenCalled();
}
it.each(['alice', 'bob'])('preserves %s in another private session', preservesOther);

async function replaceGeneration() {
  await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant',
    computerId: 'computer', sandboxUid: 'replacement', generation: 2, tokenId: 'token:new' });
  await append('computer-assistant', 'computer.ready', { assistantId: 'assistant',
    computerId: 'computer', generation: 2, podUid: 'replacement' });
}
async function refusesReplacement() {
  await invalidated();
  await replaceGeneration();
  await poll();
  expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
  expect(computer.grants.has('thread-1')).toBe(true);
}
it('does not send an old invalidation to a replacement computer generation', refusesReplacement);

function holdHistory() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = nats.store.readStream.bind(nats.store);
  let reads = 0;
  async function* held(...args: Parameters<typeof read>) {
    if (args[0] === 'conversation-chat') {
      reads++;
      entered.resolve();
      await release.promise;
    }
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(held);
  function count() { return reads; }
  return { entered: entered.promise, release: release.resolve, count };
}
async function changesDuringHistory(change: 'generation' | 'terminal' | 'disconnect') {
  await invalidated();
  const held = holdHistory();
  const pending = link.memory.poll('chat');
  await held.entered;
  try {
    void processor.pollMemory(sessions);
    expect(held.count()).toBe(1);
    if (change === 'generation') await replaceGeneration();
    if (change === 'terminal') {
      computer.finish('thread-1');
      await flush();
    }
    if (change === 'disconnect') {
      link.socket.terminate();
      await once(link.socket, 'close');
    }
  } finally { held.release(); }
  await pending;
  if (change !== 'disconnect') await flush();
  expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
  expect(opening).not.toHaveBeenCalled();
}
it.each(['generation', 'terminal', 'disconnect'] as const)(
  'rechecks %s after awaited history', changesDuringHistory);

async function doesNotBlockOther() {
  await otherTurn();
  const other = { ...prepared, conversationId: 'other', turnId: 'other-turn', threadId: 'thread-2' };
  await append('conversation-other', 'agent.memory_context_recorded', other);
  const position = await nats.store.head(`scope-${scopeId}`);
  await append('conversation-other', 'agent.memory_context_recorded', { ...other,
    action: 'loaded', delivery: 'initial', additions: [{ scopeId, memoryId: 'fact', revision: 1 }],
    scopePositions: [{ scopeId, position }], byteCount: 50 });
  await invalidated();
  const causes = await history(nats.store, `scope-${scopeId}`, 'test');
  const request = { conversationId: 'other', turnId: 'other-turn', threadId: 'thread-2',
    inputGeneration: '1', causeId: causes.at(-1)!.event.id };
  expect(await invalidateMemoryContext({ silo: 'test', store: nats.store }, request))
    .toMatchObject({ status: 'invalidated' });
  const held = holdHistory();
  void processor.pollMemory(sessions);
  await held.entered;
  try {
    function interrupted() { expect(computer.calls).toContain('turn/interrupt:thread-2'); }
    await vi.waitFor(interrupted);
    expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
    link.socket.terminate();
    await once(link.socket, 'close');
  } finally { held.release(); }
  await link.memory.poll('chat');
  expect(opening).not.toHaveBeenCalled();
}
it('keeps other conversation checks and connection shutdown independent of stalled history',
  doesNotBlockOther);

async function replayAndUnrelated() {
  const decrypt = vi.spyOn(keys, 'decrypt');
  await append('conversation-chat', 'file.uploaded', { conversationId: 'chat', fileId: 'upload',
    uploadedBy: 'alice', name: 'file.txt', size: 1, sha256: 'a'.repeat(64),
    mime: 'text/plain', objectKey: 'test/chat/upload' });
  const encrypted = keys.encrypt('test', 'chat', 'Independent human message');
  await append('conversation-chat', 'message.posted', { conversationId: 'chat',
    authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted });
  await invalidated();
  const before = [...computer.calls];
  const cold = { readStream: nats.store.readStream.bind(nats.store) };
  const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
  expect(facts.memoryContext?.status).toBe('invalidated');
  expect(computer.calls).toEqual(before);
  await poll();
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
  expect(link.socket.readyState).toBe(link.socket.OPEN);
  expect(decrypt).not.toHaveBeenCalled();
}
it('replays without effects and delivers despite unrelated uploads and human messages',
  replayAndUnrelated);

async function racingPollsShareInterrupt() {
  await invalidated();
  const removing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const grant = computer.driver.grant.bind(computer.driver);
  async function heldRemoval(...args: Parameters<typeof grant>) {
    await grant(...args);
    if (args[0] === 'thread-1' && !args[2]) {
      removing.resolve();
      await release.promise;
    }
  }
  computer.driver.grant = heldRemoval;
  try {
    await poll();
    await removing.promise;
    await Promise.all([poll(), poll()]);
    expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
  } finally { release.resolve(); }
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
}
it('shares an in-flight interruption across repeated and racing polls', racingPollsShareInterrupt);

async function startReplacement() {
  const encrypted = keys.encrypt('test', 'chat', 'New request');
  await append('conversation-chat', 'message.posted', { conversationId: 'chat',
    authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted }, 'replacement');
  await append('computer-assistant', 'computer.turn_started', { conversationId: 'chat',
    turnId: 'replacement', requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    threadId: 'thread-2', task: 'chat_turn', executionMode: 'restricted' });
  await startTurn('replacement', 'chat', 'alice', 'thread-2');
}

async function delayedStopPreservesReplacement() {
  await invalidated();
  const send = link.socket.send.bind(link.socket);
  let delayed: Parameters<typeof send>[0] | undefined;
  function hold(data: Parameters<typeof send>[0]) {
    if (typeof data === 'string' && data.includes('"type":"stop"')) delayed = data;
    else send(data);
  }
  const sending = vi.spyOn(link.socket, 'send').mockImplementation(hold);
  await poll();
  expect(delayed).toBeDefined();
  computer.finish('thread-1');
  await flush();
  await link.settled();
  await startReplacement();
  sending.mockRestore();
  send(delayed!);
  await flush();
  expect(computer.grants.has('thread-2')).toBe(true);
  expect(computer.calls).not.toContain('turn/interrupt:thread-2');
}
it('keeps a replacement private turn running when an old Stop arrives late',
  delayedStopPreservesReplacement);

async function boundsHistory() {
  await invalidated();
  const held = holdHistory();
  const before = performance.now();
  const pending = link.memory.poll('chat');
  await held.entered;
  try {
    await pending;
    expect(performance.now() - before).toBeLessThan(12_000);
    expect(computer.calls.filter(targetInterrupt)).toHaveLength(0);
  } finally { held.release(); }
  await poll();
  function interrupted() { expect(computer.calls.filter(targetInterrupt)).toHaveLength(1); }
  await vi.waitFor(interrupted);
}
it('bounds a stalled history read and retries it on a later poll', boundsHistory, 15_000);

async function completionBeforePoll(replace: boolean) {
  const send = link.socket.send.bind(link.socket);
  let stops = 0;
  function holdAcknowledgements(data: Parameters<typeof send>[0]) {
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === 'ack' && !('token' in frame)) return;
      if (frame.type === 'stop') stops++;
    }
    send(data);
  }
  vi.spyOn(link.socket, 'send').mockImplementation(holdAcknowledgements);
  computer.channel.notification({ method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', itemId: 'reply', delta: 'completed-private-canary' } });
  await flush();
  await link.settled();
  await invalidated();
  computer.finish('thread-1');
  await flush();
  await link.settled();
  if (replace) await startReplacement();
  await poll();
  let replayed = false;
  function inspect(raw: Buffer) {
    if (raw.toString().includes('completed-private-canary')) replayed = true;
  }
  link.socket.on('message', inspect);
  send(JSON.stringify({ type: 'resume', since: 0 }));
  await flush();
  await link.settled();
  await poll();
  expect(link.rejection).toBeUndefined();
  if (replace) {
    expect(computer.grants.has('thread-2')).toBe(true);
    expect(computer.calls).not.toContain('turn/interrupt:thread-2');
  }
  expect({ stops, privateTextReplayedAfterInvalidation: replayed })
    .toEqual({ stops: 1, privateTextReplayedAfterInvalidation: false });
}
it.each([false, true])('clears withdrawn output when completion precedes polling, replacement=%s',
  completionBeforePoll);

async function retriesUntilClearanceReceipt() {
  const send = WebSocket.prototype.send;
  let heldReceipt: string | undefined;
  let peer: WebSocket | undefined;
  let stops = 0;
  function holdReceipt(this: WebSocket, data: Parameters<typeof send>[0]) {
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as { type: string };
      if (frame.type === 'private_output_cleared') {
        heldReceipt = data;
        peer = this;
        return;
      }
      if (frame.type === 'stop') stops++;
    }
    send.call(this, data);
  }
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(holdReceipt);
  await invalidated();
  computer.finish('thread-1');
  await flush();
  await link.settled();
  await poll();
  expect(stops).toBe(1);
  expect(heldReceipt).toBeDefined();
  const wrongThread = { type: 'private_output_cleared', conversationId: 'chat',
    turnId: 'turn', threadId: 'another-thread' };
  send.call(peer!, JSON.stringify(wrongThread));
  await flush();
  await poll();
  expect(stops).toBe(2);
  send.call(peer!, heldReceipt!);
  await flush();
  await poll();
  expect(stops).toBe(2);
  expect(link.rejection).toBeUndefined();
}
it('retries completed withdrawal until the exact computer clearance receipt arrives',
  retriesUntilClearanceReceipt);
