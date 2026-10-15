import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { readChatFacts } from '../src/chat/chat-summary.ts';

const type = 'agent.memory_context_recorded';
const personal = { scopeId: 'a'.repeat(64), memoryId: 'personal', revision: 1 };
const shared = { scopeId: 'b'.repeat(64), memoryId: 'shared', revision: 1 };
const identity = { conversationId: 'chat', turnId: 'turn', requesterId: 'alice',
  assistantId: 'assistant', computerId: 'computer', generation: 1, threadId: 'thread',
  inputGeneration: 'context' };
const prepared = { ...identity, action: 'prepared', delivery: null, callDigest: null,
  dispatchDigest: null, additions: [], scopePositions: [], projectionGeneration: 'projection',
  byteCount: 0, hasOmissions: false, reason: 'none' };
const loaded = { ...prepared, action: 'loaded', delivery: 'recall',
  callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64), additions: [personal],
  scopePositions: [{ scopeId: personal.scopeId, position: 1 }], byteCount: 100 };
function event(id: string, data: object, patch: Partial<EventEnvelope> = {}): EventEnvelope {
  return { id, commandId: id, principal: { kind: 'system', id: 'server' }, type,
    source: 'opencrane-server', subject: 'conversation-chat', silo: 'test',
    time: '2026-10-12T00:00:00Z', correlation: {}, data, ...patch };
}
function fixture(events: EventEnvelope[]) {
  const rows: StoredEvent[] = [];
  for (const saved of events) {
    const row = { event: saved, sequence: rows.length + 1 };
    rows.push(row);
  }
  async function* readStream(_subject: string, from = 1) {
    await Promise.resolve();
    for (const row of rows) {
      if (row.sequence >= from) {
        yield row;
      }
    }
  }
  const store = { readStream };
  function read(turnId = 'turn') {
    return readChatFacts(store, 'test', 'chat', turnId);
  }
  function append(saved: EventEnvelope) {
    rows.push({ event: saved, sequence: rows.length + 1 });
  }
  return { read, append };
}
function contract() {
  expect(getEventDefinition(type)?.stream).toBe('conversation');
  expect(parseEventByType(event('prepared', prepared)).success).toBe(true);
  expect(parseEventByType(event('loaded', loaded)).success).toBe(true);
}
it('registers server memory evidence on the conversation stream', contract);

async function lostReply() {
  const events = [event('prepared', prepared), event('loaded', loaded)];
  const live = fixture(events);
  const expected = { memoryContext: { status: 'loaded', references: [personal],
    recallCalls: 1, recallBytes: 100, executionAvailable: false } };
  expect(await live.read()).toMatchObject(expected);
  expect(await live.read()).toMatchObject(expected);
  expect(await fixture(events).read()).toMatchObject(expected);
  live.append(events[1]!);
  expect(await live.read()).toMatchObject(expected);
}
it('retains loaded references after a lost reply, repeated reads and cold replay', lostReply);

async function missingEvidence() {
  const facts = await fixture([event('prepared', prepared)]).read();
  expect(facts).toMatchObject({ memoryContext: { status: 'prepared', references: [],
    recallCalls: 0, executionAvailable: false } });
}
it('does not treat preparation as proof of delivery', missingEvidence);

async function separatesScopes() {
  const next = { ...loaded, callDigest: 'e'.repeat(64), dispatchDigest: 'f'.repeat(64),
    additions: [shared], scopePositions: [{ scopeId: shared.scopeId, position: 2 }] };
  const events = [event('prepared', prepared), event('loaded', loaded), event('shared', next)];
  const facts = await fixture(events).read();
  expect(facts).toMatchObject({ memoryContext: { references: [personal, shared],
    recallCalls: 2, recallBytes: 200, executionAvailable: false } });
  expect(await fixture(events).read('other')).toMatchObject({ memoryContext: undefined });
}
it('keeps personal and shared references distinct and confined to their turn', separatesScopes);

const changes = [{ requesterId: 'bob' }, { assistantId: 'other' }, { computerId: 'other' },
  { generation: 2 }, { threadId: 'other' }, { inputGeneration: 'other' },
  { projectionGeneration: 'replacement' }];
async function changedIdentity(patch: object) {
  const changed = { ...loaded, ...patch };
  const events = [event('prepared', prepared), event('loaded', changed)];
  await expect(fixture(events).read()).rejects.toThrow();
}
it.each(changes)('refuses changed identity or generation: %j', changedIdentity);

async function duplicateCall() {
  const events = [event('prepared', prepared), event('loaded', loaded), event('retry', loaded)];
  await expect(fixture(events).read()).rejects.toThrow();
  const changed = { ...loaded, additions: [shared] };
  events[2] = event('loaded', changed);
  await expect(fixture(events).read()).rejects.toThrow();
}
it('refuses a second call record and conflicting duplicate event data', duplicateCall);

async function terminal(action: string, reason: string) {
  const stopped = { ...prepared, action, reason };
  const events = [event('prepared', prepared), event('loaded', loaded), event('stop', stopped)];
  expect(await fixture(events).read()).toMatchObject({ memoryContext: {
    status: action, references: [personal], recallCalls: 1 } });
  events.push(event('late', { ...loaded, callDigest: 'e'.repeat(64) }));
  await expect(fixture(events).read()).rejects.toThrow();
}
it.each([['invalidated', 'expired'], ['invalidated', 'access_changed'], ['ended', 'ended']])(
  'retains evidence and refuses late delivery after %s (%s)', terminal);

async function recallLimit() {
  const events = [event('prepared', prepared)];
  for (let index = 0; index < 4; index++) {
    const next = { ...loaded, additions: [], byteCount: 16384,
      callDigest: String(index).repeat(64), dispatchDigest: String(index).repeat(64) };
    events.push(event(`call-${index}`, next));
  }
  expect(await fixture(events).read()).toMatchObject({ memoryContext: {
    recallCalls: 4, recallBytes: 65536, references: [] } });
  events.push(event('fifth', { ...loaded, additions: [], byteCount: 0 }));
  await expect(fixture(events).read()).rejects.toThrow();
}
it('counts empty recalls and refuses a fifth reply without dropping earlier evidence', recallLimit);

async function referenceLimit() {
  const additions = [];
  for (let index = 0; index < 32; index++) {
    additions.push({ ...personal, memoryId: `fact-${index}` });
  }
  const initial = { ...loaded, delivery: 'initial', callDigest: null, dispatchDigest: null,
    additions, byteCount: 16384 };
  const events = [event('prepared', prepared), event('initial', initial)];
  const repeated = { ...loaded, additions: [additions[0]!] };
  events.push(event('repeated', repeated));
  expect(await fixture(events).read()).toMatchObject({ memoryContext: { recallCalls: 1 } });
  events.push(event('overflow', { ...loaded, callDigest: 'e'.repeat(64) }));
  await expect(fixture(events).read()).rejects.toThrow();
}
it('counts unique references across initial input and recall, with no eviction', referenceLimit);

function privateFields(field: string) {
  const definition = getEventDefinition(type);
  expect(definition).toBeDefined();
  const data = { ...loaded, [field]: 'private-canary' };
  expect(definition!.dataSchema.safeParse(data).success).toBe(false);
}
it.each(['text', 'ciphertext', 'keyId', 'result', 'textDigest'])(
  'refuses private payload field %s', privateFields);

function untrusted(patch: Partial<EventEnvelope>) {
  expect(parseEventByType(event('valid', loaded)).success).toBe(true);
  expect(parseEventByType(event('invalid', loaded, patch)).success).toBe(false);
}
it.each([{ source: 'computer-bridge' }, { subject: 'conversation-other' },
  { report: { computerId: 'computer', sequence: 1, digest: 'a'.repeat(64) } }])(
  'refuses computer reports and a mismatched stream: %j', untrusted);

async function needsPreparation() {
  await expect(fixture([event('loaded', loaded)]).read()).rejects.toThrow();
  const events = [event('prepared', prepared), event('again', prepared)];
  await expect(fixture(events).read()).rejects.toThrow();
}
it('requires exactly one preparation before any load', needsPreparation);

const invalidRecords = [
  { additions: Array(21).fill(personal) }, { byteCount: 16385 },
  { byteCount: 1.5 }, { reason: 'private words' },
  { callDigest: null }, { dispatchDigest: null },
  { additions: [{ ...personal, revision: 0 }] },
  { scopePositions: [{ scopeId: personal.scopeId, position: -1 }] },
  { additions: [{ ...personal, text: 'private-canary' }] },
];
function invalidRecord(patch: object) {
  expect(parseEventByType(event('valid', loaded)).success).toBe(true);
  expect(parseEventByType(event('invalid', { ...loaded, ...patch })).success).toBe(false);
}
it.each(invalidRecords)('refuses malformed evidence: %j', invalidRecord);

async function changedReference() {
  const next = { ...loaded, callDigest: 'e'.repeat(64), dispatchDigest: 'f'.repeat(64),
    additions: [{ ...personal, revision: 2 }] };
  const events = [event('prepared', prepared), event('loaded', loaded), event('changed', next)];
  await expect(fixture(events).read()).rejects.toThrow();
}
it('refuses replacing an already loaded revision', changedReference);

async function concurrentReads() {
  const saved = fixture([event('prepared', prepared), event('loaded', loaded)]);
  const results = await Promise.all([saved.read(), saved.read()]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ memoryContext: { recallCalls: 1, references: [personal] } });
}
it('does not count a call twice when two summary reads race', concurrentReads);

function oversizedRecord() {
  expect(parseEventByType(event('x'.repeat(16384), loaded)).success).toBe(false);
}
it('refuses a complete evidence event above the byte limit', oversizedRecord);

async function turnClosed() {
  const closed = event('closed', { conversationId: 'chat', turnId: 'turn' },
    { type: 'agent.turn_completed' });
  const events = [event('prepared', prepared), event('loaded', loaded), closed];
  expect(await fixture(events).read()).toMatchObject({ turnEnded: true, memoryContext: {
    status: 'ended', references: [personal], executionAvailable: false } });
  events.push(event('late', { ...loaded, callDigest: 'e'.repeat(64) }));
  await expect(fixture(events).read()).rejects.toThrow();
}
it('keeps references when the turn closes and refuses later load records', turnClosed);

async function participationClose(lateDelivery: 'initial' | 'recall') {
  const nats = await natsFixture();
  try {
    async function append(saved: EventEnvelope) {
      const expectedSequence = await nats.store.head(saved.subject);
      const result = await nats.store.append({ event: saved, expectedSequence });
      expect(result.status).toBe('appended');
    }
    await append(event('prepared', prepared));
    if (lateDelivery === 'recall') {
      await append(event('loaded', loaded));
    }
    const warm = await readChatFacts(nats.store, 'test', 'chat', 'turn');
    const references = lateDelivery === 'recall' ? [personal] : [];
    const status = lateDelivery === 'recall' ? 'loaded' : 'prepared';
    expect(warm.memoryContext).toMatchObject({ status, references });

    const close = envelope('test', 'participation-chat', 'conversation.closed', {
      conversationId: 'chat', closedBy: 'alice',
    });
    await append(close);
    const coldStore = { readStream: nats.store.readStream.bind(nats.store) };
    for (const store of [nats.store, coldStore]) {
      const facts = await readChatFacts(store, 'test', 'chat', 'turn');
      expect.soft(facts).toMatchObject({ turnEnded: false, conversationClosed: true,
        memoryContext: { status: 'ended', references, executionAvailable: false } });
    }

    const lateLoad = lateDelivery === 'initial'
      ? { ...loaded, delivery: 'initial', callDigest: null, dispatchDigest: null }
      : { ...loaded, callDigest: 'e'.repeat(64), dispatchDigest: 'f'.repeat(64) };
    await append(event('late-load', lateLoad));
    for (const store of [nats.store, coldStore]) {
      const reading = readChatFacts(store, 'test', 'chat', 'turn');
      if (lateDelivery === 'initial') {
        await expect(reading).rejects.toThrow('Memory evidence arrived after the turn closed');
      } else {
        await expect(reading).resolves.toMatchObject({ turnEnded: false, conversationClosed: true,
          memoryContext: { status: 'ended', reason: 'ended', references: [personal],
            recallCalls: 2, recallBytes: 200, executionAvailable: false } });
      }
    }
  } finally {
    await nats.close();
  }
}
it.each(['initial', 'recall'] as const)(
  'keeps a participation close terminal when later %s evidence arrives',
  participationClose);

async function savedAppendRace() {
  const nats = await natsFixture();
  try {
    const first = { event: event('prepared', prepared), expectedSequence: 0 };
    const saved = await nats.store.append(first);
    expect(saved.status).toBe('appended');
    if (saved.status !== 'appended') {
      throw new Error('Preparation was not saved');
    }
    const firstLoad = { event: event('loaded', loaded), expectedSequence: saved.sequence };
    const secondLoad = { event: event('racing', loaded), expectedSequence: saved.sequence };
    const appends = [nats.store.append(firstLoad), nats.store.append(secondLoad)];
    const results = await Promise.all(appends);
    function status(result: typeof results[number]) {
      return result.status;
    }
    const statuses = results.map(status);
    expect(statuses.sort()).toEqual(['appended', 'conflict']);
    // Discard the successful reply and rebuild from the event store alone.
    const coldStore = { readStream: nats.store.readStream.bind(nats.store) };
    const facts = await readChatFacts(coldStore, 'test', 'chat', 'turn');
    expect(facts).toMatchObject({ memoryContext: { recallCalls: 1, references: [personal],
      executionAvailable: false } });
  } finally {
    await nats.close();
  }
}
it('keeps one durable load when conditional appends race and the reply is lost', savedAppendRace);
