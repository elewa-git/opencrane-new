import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema, memoryWrittenDataSchema, parseEventByType,
  type MemoryIdentity } from '@opencrane/events';
import { history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../../apps/server/src/chat/chat-summary.ts';
import { invalidateMemoryContext } from '../../apps/server/src/memory/invalidation.ts';

export function memoryJourney(store: EventStore, silo: string, conversationId = 'chat',
  requesterId = 'alice', causeId = 'cause', encode?: (identity: MemoryIdentity) => object) {
  const subject = `conversation-${conversationId}`;
  const scopeId = memoryScopeId(silo, 'person', requesterId);
  const memoryWrittenExample = { schemaVersion: 1, scopeKind: 'person', ownerId: requesterId,
    revision: 1, kind: 'fact', pinned: false, expiresAt: null, sources: [], dependsOn: [],
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
  const reference = { scopeId, memoryId: 'fact', revision: 1 };
  const input = { conversationId, turnId: 'turn', threadId: 'thread',
    inputGeneration: 'input', causeId };
  const prepared = { conversationId, turnId: 'turn', requesterId,
    assistantId: 'assistant', computerId: 'computer', generation: 1, threadId: 'thread',
    inputGeneration: 'input', projectionGeneration: 'projection', action: 'prepared',
    delivery: null, callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
    byteCount: 0, hasOmissions: false, reason: 'none' };
  async function append(subject: string, type: string, data: object, id?: string) {
    const eventId = id ?? randomUUID();
    const fields: Record<string, unknown> = { ...data };
    if (type === 'memory.written' || type === 'memory.corrected') {
      const identitySchema = memoryWrittenDataSchema.pick({ scopeId: true, scopeKind: true,
        ownerId: true, memoryId: true });
      const schema = identitySchema.extend({ revision: z.int().positive() });
      const fieldsSchema = schema.strip();
      const value = fieldsSchema.parse(fields);
      const hash = createHash('sha256');
      hash.update(JSON.stringify([silo, value.scopeId, value.scopeKind, value.ownerId,
        value.memoryId, value.revision]));
      fields['keyId'] = `key:${hash.digest('hex')}`;
      if (encode) {
        const identity = { silo, ...value };
        const encrypted = encode(identity);
        Object.assign(fields, encrypted);
      }
    }
    const event = { id: eventId, commandId: eventId, silo, subject, type, data: fields,
      source: 'opencrane-server', time: new Date().toISOString(), correlation: {},
      principal: { kind: 'system' as const, id: 'server' } };
    assert(parseEventByType(event).success);
    const expectedSequence = await store.head(subject);
    const result = await store.append({ event, expectedSequence });
    assert.equal(result.status, 'appended');
    return event;
  }
  async function load(additions = [reference], patch = {}) {
    const position = await store.head(`scope-${scopeId}`);
    const data = { ...prepared, action: 'loaded', delivery: 'recall',
      callDigest: 'a'.repeat(64), dispatchDigest: 'b'.repeat(64), byteCount: 100,
      additions, scopePositions: [{ scopeId, position }], ...patch };
    await append(subject, 'agent.memory_context_recorded', data);
  }
  async function start() {
    await append(subject, 'conversation.created', { conversationId,
      createdBy: requesterId, assistantId: 'assistant', mode: 'agent_session' });
    await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
      scopeId, memoryId: 'base' });
    await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
      scopeId, memoryId: 'fact', dependsOn: [{ scopeId, memoryId: 'base', revision: 1 }] });
    await append(subject, 'agent.memory_context_recorded', prepared);
    await load();
  }
  async function change(kind: 'corrected' | 'forgotten', memoryId = 'fact') {
    const identity = { scopeId, scopeKind: 'person', ownerId: requesterId, memoryId,
      schemaVersion: 1, revision: 2, expectedRevision: 1 };
    let data: object = identity;
    if (kind === 'corrected') {
      data = { ...memoryWrittenExample, ...identity, revision: 2,
        supersedes: { memoryId, revision: 1 }, reason: 'human' };
    }
    return append(`scope-${scopeId}`, `memory.${kind}`, data, causeId);
  }
  function invalidate(patch = {}) {
    const options = { silo, store };
    return invalidateMemoryContext(options, { ...input, ...patch });
  }
  async function exactInvalidation(kind: 'corrected' | 'forgotten') {
    await change(kind);
    const causePosition = await store.head(`scope-${scopeId}`);
    const receipt = await invalidate();
    assert.equal(receipt.status, 'invalidated');
    assert('inputGeneration' in receipt && receipt.inputGeneration === 'input');
    assert('eventId' in receipt && typeof receipt.eventId === 'string');
    const facts = await readChatFacts(store, silo, conversationId, 'turn');
    assert.equal(facts.memoryContext?.status, 'invalidated');
    assert.deepEqual(facts.memoryContext.references, [reference]);
    assert.equal(facts.memoryContext.executionAvailable, false);
    assert.equal(facts.memoryContext.recallCalls, 1);
    const rows = await history(store, subject, silo);
    const saved = memoryContextRecordedEventSchema.parse(rows.at(-1)!.event);
    const expected = { ...prepared, action: 'invalidated', reason: 'content_changed',
      scopePositions: [{ scopeId, position: causePosition }] };
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(Reflect.get(saved.data, field), value);
    }
    assert.deepEqual(await invalidate(), receipt);
    assert.equal(await store.head(subject), rows.at(-1)!.sequence);
  }
  async function unrelatedChange(kind: 'corrected' | 'forgotten') {
    await append(`scope-${scopeId}`, 'memory.written', { ...memoryWrittenExample,
      scopeId, memoryId: 'other' });
    await change(kind, 'other');
    const position = await store.head(subject);
    assert.deepEqual(await invalidate(), { status: 'unchanged' });
    assert.equal(await store.head(subject), position);
  }
  async function otherContext(otherRequester: string) {
    const otherConversation = randomUUID();
    const otherSubject = `conversation-${otherConversation}`;
    const otherScope = memoryScopeId(silo, 'person', otherRequester);
    const otherReference = { scopeId: otherScope, memoryId: randomUUID(), revision: 1 };
    const fact = { ...memoryWrittenExample, ownerId: otherRequester, ...otherReference };
    await append(`scope-${otherScope}`, 'memory.written', fact);
    const creation = { conversationId: otherConversation, createdBy: otherRequester,
      assistantId: prepared.assistantId, mode: 'agent_session' };
    await append(otherSubject, 'conversation.created', creation);
    const preparation = { ...prepared, conversationId: otherConversation,
      requesterId: otherRequester, threadId: randomUUID(), inputGeneration: randomUUID() };
    await append(otherSubject, 'agent.memory_context_recorded', preparation);
    const position = await store.head(`scope-${otherScope}`);
    const loaded = { ...preparation, action: 'loaded', delivery: 'initial',
      additions: [otherReference], scopePositions: [{ scopeId: otherScope, position }],
      byteCount: 100 };
    await append(otherSubject, 'agent.memory_context_recorded', loaded);
    return { conversationId: otherConversation, subject: otherSubject,
      reference: otherReference, preparation };
  }
  async function isolatedContext(kind: 'corrected' | 'forgotten', otherRequester = requesterId) {
    const other = await otherContext(otherRequester);
    const before = await readChatFacts(store, silo, other.conversationId, 'turn');
    assert.equal(before.memoryContext?.status, 'loaded');
    assert.deepEqual(before.memoryContext.references, [other.reference]);
    const otherPosition = await store.head(other.subject);
    await exactInvalidation(kind);
    // Refuse another session's thread and generation even when the requester is the same.
    const targetPosition = await store.head(subject);
    const foreignThread = { threadId: other.preparation.threadId };
    const foreignGeneration = { inputGeneration: other.preparation.inputGeneration };
    assert.deepEqual(await invalidate(foreignThread), { status: 'refused' });
    assert.deepEqual(await invalidate(foreignGeneration), { status: 'refused' });
    assert.equal(await store.head(subject), targetPosition);
    const options = { silo, store };
    const otherInput = { ...input, conversationId: other.conversationId,
      threadId: other.preparation.threadId, inputGeneration: other.preparation.inputGeneration };
    let expectedStatus = 'unchanged';
    if (otherRequester !== requesterId) expectedStatus = 'refused';
    assert.deepEqual(await invalidateMemoryContext(options, otherInput), { status: expectedStatus });
    assert.equal(await store.head(other.subject), otherPosition);
    // Rebuild from stored events too, so an unchanged cache cannot hide a cross-session write.
    const cold = { readStream: store.readStream.bind(store) };
    const after = await readChatFacts(cold, silo, other.conversationId, 'turn');
    assert.deepEqual(after.memoryContext, before.memoryContext);
  }
  return { scopeId, memoryWrittenExample, reference, input, prepared, append, load,
    start, change, invalidate, exactInvalidation, unrelatedChange, isolatedContext };
}
