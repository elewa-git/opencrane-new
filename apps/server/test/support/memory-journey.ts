import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema, memoryWrittenDataSchema, parseEventByType,
  type MemoryIdentity } from '@opencrane/events';
import { history } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../../src/chat/chat-summary.ts';
import { invalidateMemoryContext } from '../../src/memory/invalidation.ts';

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
  return { scopeId, memoryWrittenExample, reference, input, prepared, append, load,
    start, change, invalidate, exactInvalidation, unrelatedChange };
}
