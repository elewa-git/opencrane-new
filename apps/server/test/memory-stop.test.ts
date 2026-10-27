import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { memoryContextRecordedEventSchema, parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { fixture } from '../../computer/test/bridge-gate-fixture.ts';
import { reportJournal } from '../../computer/test/server.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { invalidateMemoryContext } from '../src/memory/invalidation.ts';
import { stopInvalidatedMemory } from '../src/memory/stop.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let computer: Awaited<ReturnType<typeof fixture>>;
const scopeId = memoryScopeId('test', 'person', 'alice');
const binding = { conversationId: 'chat', turnId: 'turn', requesterId: 'alice',
  assistantId: 'assistant', computerId: 'computer', generation: 1,
  threadId: 'thread-1', inputGeneration: 'input' };
const prepared = { ...binding, projectionGeneration: 'projection', action: 'prepared',
  delivery: null, callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
  byteCount: 0, hasOmissions: false, reason: 'none' };
let active: { silo: string; binding: typeof binding; socket: typeof computer.socket } | undefined;
function current() { return active; }
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
  computer.send(frame);
  function running() { expect(computer.calls).toContain(`turn/start:${threadId}`); }
  await vi.waitFor(running);
  await computer.flush();
}
async function setup() {
  nats = await natsFixture();
  computer = await fixture();
  active = { silo: 'test', binding: { ...binding }, socket: computer.socket };
  await append('conversation-chat', 'conversation.created', { conversationId: 'chat',
    createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session' });
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
    inputGeneration: 'input', causeId: cause.id };
  expect(await invalidateMemoryContext(options, request)).toMatchObject({ status: 'invalidated' });
  const rows = await history(nats.store, 'conversation-chat', 'test');
  return memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
}
function react(event: unknown) {
  const options = { silo: 'test', store: nats.store, current };
  return stopInvalidatedMemory(options, event);
}
function output(threadId: string, text: string) {
  computer.channel.notification({ method: 'item/agentMessage/delta',
    params: { threadId, itemId: 'reply', delta: text } });
}
async function replay() {
  computer.frames.length = 0;
  computer.send({ type: 'resume', since: 0 });
  await computer.flush();
  return JSON.stringify(computer.frames);
}
async function stopsExactTurn(kind: 'corrected' | 'forgotten', requester: string) {
  await startTurn();
  await startTurn('other', 'other-chat', requester, 'thread-2');
  output('thread-1', 'withdrawn-canary');
  output('thread-2', 'unaffected-canary');
  await computer.flush();
  const event = await invalidated(kind);
  const removing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const grant = computer.driver.grant;
  async function heldRemoval(...args: Parameters<typeof grant>) {
    await grant(...args);
    if (args[0] === 'thread-1' && !args[2]) {
      removing.resolve();
      await release.promise;
    }
  }
  computer.driver.grant = heldRemoval;
  computer.pauseAcks();
  function failed(error: unknown) { return error; }
  const renewal = computer.channel.renew('thread-1').catch(failed);
  await computer.flush();
  try {
    expect(await react(event)).toBe('sent');
    await removing.promise;
    expect(await renewal).toEqual(new Error('Turn ended'));
    expect(computer.grants.has('thread-1')).toBe(false);
    expect(computer.grants.has('thread-2')).toBe(true);
    expect(computer.calls).not.toContain('turn/interrupt:thread-1');
    output('thread-1', 'late-canary');
    const replayed = await replay();
    expect(replayed).not.toMatch(/withdrawn-canary|late-canary/u);
    expect(replayed).toContain('agent.output_lost');
    expect(replayed).toContain('unaffected-canary');
    expect(await react(event)).toBe('sent');
  } finally { release.resolve(); }
  function interrupted() { expect(computer.calls).toContain('turn/interrupt:thread-1'); }
  await vi.waitFor(interrupted);
  expect(computer.calls).not.toContain('turn/interrupt:thread-2');
  await expect(computer.channel.renew('thread-1')).rejects.toThrow('Turn ended');
  const before = [...computer.calls];
  const cold = { readStream: nats.store.readStream.bind(nats.store) };
  const facts = await readChatFacts(cold, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'invalidated', executionAvailable: false });
  expect(facts.memoryContext?.references).toHaveLength(1);
  const journal = reportJournal(computer.driver);
  journal.load();
  expect(JSON.stringify(journal.reports)).not.toMatch(/withdrawn-canary|late-canary/u);
  expect(computer.calls).toEqual(before);
}
const isolationCases = [['corrected', 'alice'], ['corrected', 'bob'],
  ['forgotten', 'alice'], ['forgotten', 'bob']] as const;
it.each(isolationCases)('stops %s context while preserving %s in another session', stopsExactTurn);

const mismatches = [
  { silo: 'other' }, { conversationId: 'other' }, { turnId: 'other' },
  { requesterId: 'bob' }, { assistantId: 'other' }, { computerId: 'other' },
  { generation: 2 }, { threadId: 'replacement' }, { inputGeneration: 'old-input' },
];
async function refusesOtherTarget(patch: object) {
  await startTurn();
  const event = await invalidated();
  active = { ...active!, binding: { ...binding, ...patch }, ...patch };
  expect(await react(event)).toBe('ignored');
  await computer.flush();
  expect(computer.grants.has('thread-1')).toBe(true);
  expect(computer.calls).not.toContain('turn/interrupt:thread-1');
}
it.each(mismatches)('does not stop a different live binding: %j', refusesOtherTarget);

async function rejectsCopiedEvidence(kind: string) {
  await startTurn();
  const event = await invalidated();
  let candidate = structuredClone(event);
  if (kind === 'silo') candidate.silo = 'other';
  if (kind === 'id') candidate.id = 'unconfirmed';
  if (kind === 'generation') candidate.data.inputGeneration = 'copied';
  if (kind === 'envelope') candidate.time = new Date(0).toISOString();
  if (kind === 'subject') candidate.subject = 'conversation-other';
  expect(await react(candidate)).toBe('ignored');
  await computer.flush();
  expect(computer.grants.has('thread-1')).toBe(true);
}
it.each(['silo', 'id', 'generation', 'envelope', 'subject'])(
  'rejects copied or unconfirmed evidence with changed %s', rejectsCopiedEvidence);

async function endedTurn(kind: 'ended' | 'completed' | 'missing') {
  await startTurn();
  const event = await invalidated();
  if (kind === 'ended') {
    await append('conversation-chat', 'agent.memory_context_recorded',
      { ...prepared, action: 'ended', reason: 'ended' });
  } else if (kind === 'completed') {
    await append('conversation-chat', 'agent.turn_completed',
      { conversationId: 'chat', turnId: 'turn' });
  } else active = undefined;
  expect(await react(event)).toBe('ignored');
  expect(computer.grants.has('thread-1')).toBe(true);
}
it.each(['ended', 'completed', 'missing'] as const)('does not stop an %s turn', endedTurn);

async function lateThreadStop() {
  await startTurn();
  output('thread-1', 'current-canary');
  await computer.flush();
  computer.send({ type: 'stop', conversationId: 'chat', turnId: 'turn', threadId: 'old-thread' });
  const replayed = await replay();
  expect(replayed).toContain('current-canary');
  expect(computer.grants.has('thread-1')).toBe(true);
  expect(computer.calls).not.toContain('turn/interrupt:thread-1');
}
it('checks the thread again on the computer before clearing any reply', lateThreadStop);

async function failedInterruption() {
  const open = computer.driver.privateSession!;
  async function failingSession() {
    const session = await open();
    async function rpc(method: string, params: Record<string, unknown>) {
      if (method === 'turn/interrupt') throw new Error('private-error-canary');
      return session.rpc(method, params);
    }
    return { ...session, rpc };
  }
  computer.driver.privateSession = failingSession;
  await startTurn();
  output('thread-1', 'withdrawn-canary');
  expect(await react(await invalidated())).toBe('sent');
  await computer.flush();
  const socket = await computer.connect();
  await computer.flush(socket);
  output('thread-1', 'late-canary');
  await computer.flush(socket);
  expect(computer.grants.has('thread-1')).toBe(false);
  await expect(computer.channel.renew('thread-1')).rejects.toThrow();
  expect(JSON.stringify(computer.frames)).not.toMatch(/late-canary|private-error-canary/u);
  function starts(call: string) { return call.startsWith('turn/start:'); }
  expect(computer.calls.filter(starts)).toHaveLength(1);
}
it('keeps failed interruption unusable after reconnect without restarting work', failedInterruption);

async function unrelatedActivity() {
  await startTurn();
  const rows = await history(nats.store, 'conversation-chat', 'test');
  for (const row of rows) expect(await react(row.event)).toBe('ignored');
  const unrelated = [
    { type: 'memory.forgotten', data: { memoryId: 'unrelated' } },
    { type: 'message.posted', data: { conversationId: 'chat' } },
    { type: 'file.uploaded', data: { conversationId: 'chat' } },
  ];
  for (const event of unrelated) expect(await react(event)).toBe('ignored');
  expect(computer.grants.has('thread-1')).toBe(true);
  expect(computer.calls).not.toContain('turn/interrupt:thread-1');
}
it('ignores unrelated facts, messages, uploads and loaded evidence', unrelatedActivity);
