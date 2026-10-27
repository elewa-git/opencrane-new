import { afterEach, beforeEach, expect, it } from 'vitest';
import { memoryContextRecordedEventSchema, memoryWrittenExample } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { invalidateMemoryContext } from '../src/memory/invalidation.ts';

let setup: Awaited<ReturnType<typeof natsFixture>>;
const scopeId = memoryScopeId('test', 'person', 'alice');
const reference = { scopeId, memoryId: 'fact', revision: 1 };
const input = { conversationId: 'chat', turnId: 'turn', threadId: 'thread',
  inputGeneration: 'input', causeId: 'cause' };
const prepared = { conversationId: 'chat', turnId: 'turn', requesterId: 'alice',
  assistantId: 'assistant', computerId: 'computer', generation: 1, threadId: 'thread',
  inputGeneration: 'input', projectionGeneration: 'projection', action: 'prepared',
  delivery: null, callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
  byteCount: 0, hasOmissions: false, reason: 'none' };
async function append(subject: string, type: string, data: object, id?: string) {
  const event = envelope('test', subject, type, data);
  event.source = 'opencrane-server';
  if (id) {
    event.id = id;
    event.commandId = id;
  }
  const expectedSequence = await setup.store.head(subject);
  const result = await setup.store.append({ event, expectedSequence });
  expect(result.status).toBe('appended');
  return event;
}
async function load(additions = [reference], patch = {}) {
  const position = await setup.store.head(`scope-${scopeId}`);
  const data = { ...prepared, action: 'loaded', delivery: 'recall',
    callDigest: 'a'.repeat(64), dispatchDigest: 'b'.repeat(64), byteCount: 100,
    additions, scopePositions: [{ scopeId, position }], ...patch };
  await append('conversation-chat', 'agent.memory_context_recorded', data);
}
async function start() {
  setup = await natsFixture();
  await append('conversation-chat', 'conversation.created', { conversationId: 'chat',
    createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session' });
  await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
    scopeId, memoryId: 'fact' });
  await append('conversation-chat', 'agent.memory_context_recorded', prepared);
  await load();
}
async function close() {
  await setup?.close();
}
beforeEach(start);
afterEach(close);
async function change(kind: 'corrected' | 'forgotten', memoryId = 'fact') {
  const identity = { scopeId, scopeKind: 'person', ownerId: 'alice', memoryId,
    schemaVersion: 1, revision: 1, expectedRevision: 1 };
  let data: object = identity;
  if (kind === 'corrected') {
    data = { ...memoryWrittenExample, ...identity, revision: 2,
      supersedes: { memoryId, revision: 1 }, reason: 'human' };
  }
  return append(`scope-${scopeId}`, `memory.${kind}`, data, 'cause');
}
function invalidate(patch = {}) {
  const options = { silo: 'test', store: setup.store };
  return invalidateMemoryContext(options, { ...input, ...patch });
}
async function exactInvalidation(kind: 'corrected' | 'forgotten') {
  await change(kind);
  const receipt = await invalidate();
  expect(receipt).toEqual({ status: 'invalidated', eventId: expect.any(String),
    inputGeneration: 'input' });
  const facts = await readChatFacts(setup.store, 'test', 'chat', 'turn');
  expect(facts.memoryContext).toMatchObject({ status: 'invalidated', references: [reference],
    executionAvailable: false, recallCalls: 1 });
  const rows = await history(setup.store, 'conversation-chat', 'test');
  const saved = memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
  expect(saved.data).toMatchObject({ ...prepared, action: 'invalidated',
    reason: 'content_changed', scopePositions: [{ scopeId, position: expect.any(Number) }] });
  expect(await invalidate()).toEqual(receipt);
  expect(await setup.store.head('conversation-chat')).toBe(rows.at(-1)!.sequence);
}
it.each(['corrected', 'forgotten'] as const)(
  'records one exact invalidation after a loaded fact is %s', exactInvalidation);
