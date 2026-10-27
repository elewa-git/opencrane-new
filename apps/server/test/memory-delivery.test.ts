import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryContextRecordedEventSchema, parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { fixture } from '../../computer/test/bridge-gate-fixture.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { invalidateMemoryContext } from '../src/memory/invalidation.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let computer: Awaited<ReturnType<typeof fixture>>;
let link: Awaited<ReturnType<typeof connectBridge>>;
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
async function append(subject: string, type: string, data: object, id = randomUUID()) {
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
  const keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
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
  await link.memory.poll('chat');
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
