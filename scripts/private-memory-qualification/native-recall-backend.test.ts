import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { history } from '@opencrane/models';
import { memoryKeys, memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../../apps/server/src/chat/chat-summary.ts';
import { recallBackend, factText, scopeId, threadId }
  from '../../apps/server/test/support/recall-backend.ts';

function mockOptions() {
  return { spy: true };
}
const options = vi.hoisted(mockOptions);
vi.mock('node:net', options);
async function filesystem() {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...original };
}
async function processes() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...original };
}
vi.mock('node:fs', filesystem);
vi.mock('node:child_process', processes);

type Backend = Awaited<ReturnType<typeof recallBackend>>;

async function storeForeignFact(test: Backend) {
  const ownerId = randomUUID();
  const member = { memberId: ownerId, email: 'other@example.test',
    displayName: 'Other member', role: 'member' };
  const joined = await test.setup.append(`member-${ownerId}`, 'member.joined', member);
  await test.setup.auth.handler.handle(joined, test.setup.db);
  const foreignScope = memoryScopeId('test', 'person', ownerId);
  const text = `My favourite walking destination is ${randomUUID()}.`;
  const identity = { silo: 'test', scopeId: foreignScope, scopeKind: 'person' as const,
    ownerId, memoryId: randomUUID(), revision: 1 };
  const keys = memoryKeys(test.memory.keyDirectory!);
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, text);
  const data = { ...identity, schemaVersion: 1, kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [], ...encrypted };
  // Store both people's facts through events and rebuild the searchable projection.
  delete (data as Partial<typeof data>).silo;
  await test.setup.append(`scope-${foreignScope}`, 'memory.written', data);
  await test.setup.runner.run(test.projection);
  return { scopeId: foreignScope, text };
}

async function questionHasNoAnswer(test: Backend, foreign: string) {
  const rows = await history(test.setup.nats.store, 'conversation-chat', 'test');
  let questions = 0;
  for (const row of rows) {
    if (row.event.type !== 'message.posted') {
      continue;
    }
    const question = test.setup.keys.decrypt('test', 'chat', row.event.data);
    expect(question).toBe('Recall my destination');
    expect(question.includes(factText)).toBe(false);
    expect(question.includes(foreign)).toBe(false);
    questions += 1;
  }
  expect(questions).toBe(1);
}

async function recordsOnlyOwnReference() {
  const test = await recallBackend();
  const foreign = await storeForeignFact(test);
  await questionHasNoAnswer(test, foreign.text);
  await test.start();
  const args = { scopeId, query: 'destination' };
  const reply = await test.native.recall(threadId, args);
  const encoded = JSON.stringify(reply);
  expect(encoded.includes(factText)).toBe(true);
  expect(encoded.includes(foreign.text)).toBe(false);
  const expected = [{ scopeId, memoryId: 'garden', revision: 1 }];
  // Read the observation taken by the backend before it releases the reply.
  expect(test.deliveries).toHaveLength(1);
  expect(test.deliveries[0]?.memoryContext?.references).toEqual(expected);
  const cold = { readStream: test.setup.nats.store.readStream.bind(test.setup.nats.store) };
  const saved = await readChatFacts(cold, 'test', 'chat', test.turnId);
  expect(saved.memoryContext?.references).toEqual(expected);
  expect(saved.memoryContext?.recallCalls).toBe(1);
  const foreignArgs = { scopeId: foreign.scopeId, query: 'destination' };
  const refused = await test.native.recall(threadId, foreignArgs);
  expect(refused).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(refused).includes(foreign.text)).toBe(false);
  expect(test.deliveries).toHaveLength(1);
  const rows = await history(test.setup.nats.store, 'conversation-chat', 'test');
  const recorded = JSON.stringify(rows);
  expect(recorded.includes(factText)).toBe(false);
  expect(recorded.includes(foreign.text)).toBe(false);
}
it('records only the requester’s stored reference before delivering scripted native recall',
  recordsOnlyOwnReference, 120_000);

async function refusesChangedInstallation() {
  const test = await recallBackend();
  await test.start();
  test.deployment.changeInstallation();
  const args = { scopeId, query: 'destination' };
  const reply = await test.native.recall(threadId, args);
  expect(reply).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(reply).includes(factText)).toBe(false);
  expect(test.deliveries).toEqual([]);
}
it('refuses recall after the admitted installation changes', refusesChangedInstallation, 120_000);
