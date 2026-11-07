import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { history } from '@opencrane/models';
import { memoryKeys, memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../../apps/server/src/chat/chat-summary.ts';
import { recallBackend, factText, scopeId, threadId }
  from '../../apps/server/test/support/recall-backend.ts';
import { recallAnswerCheck } from './native-recall-checks.ts';
import { fixture as answerFixture } from './native-recall-answer.fixture.ts';
import { readDeploymentQualification } from './deployment.ts';

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
  const keys = memoryKeys(test.memory.keyDirectory);
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, text);
  const data = { scopeId: foreignScope, scopeKind: 'person', ownerId,
    memoryId: identity.memoryId, revision: 1, schemaVersion: 1, kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [], ...encrypted };
  // Store both people's facts through events and rebuild the searchable projection.
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
    expect(question === 'Recall my destination').toBe(true);
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
  const refusedText = JSON.stringify(refused);
  expect(refusedText.includes('"structuredContent"')).toBe(false);
  expect(refusedText.includes(foreign.text)).toBe(false);
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
  await readDeploymentQualification('test');
  test.deployment.changeInstallation();
  await expect(readDeploymentQualification('test')).rejects.toThrow();
  expect(test.deliveries).toEqual([]);
}
it('rejects copied qualification after the fixture installation changes',
  refusesChangedInstallation, 120_000);

const recalledFact = z.object({ text: z.string() });
const recalledPage = z.object({ result: z.object({
  structuredContent: z.object({ facts: z.array(recalledFact).min(1) }),
}) });

async function checksStoredAnswer() {
  const test = await recallBackend();
  const local = answerFixture();
  local.binding.requesterId = 'alice';
  local.binding.threadId = threadId;
  local.binding.turnId = test.turnId;
  local.binding.conversationId = 'chat';
  local.reference.scopeId = scopeId;
  local.reference.memoryId = 'garden';
  local.observed.binding = { ...local.binding };
  local.observed.current = { ...local.reference };
  local.state.nativeThread = threadId;
  local.observed.expiresAt = Date.now() + 60_000;
  let delivered = false;
  async function read() {
    const facts = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
    let references = facts.memoryContext?.references ?? [];
    if (delivered) {
      // Use the observation made inside the backend before its reply was sent.
      references = test.deliveries[0]?.memoryContext?.references ?? [];
      expect(test.requests[0]?.['requester'] === 'alice').toBe(true);
      expect(test.requests[0]?.['thread'] === threadId).toBe(true);
      expect(facts.memoryContext?.references).toEqual(references);
    }
    return { ...local.observed, references };
  }
  async function dispatch(question: string, loaded: () => Promise<boolean>,
    receive: (value: unknown) => void) {
    await test.start();
    const args = { scopeId, query: 'destination' };
    const reply = await test.native.recall(threadId, args);
    const encoded = JSON.stringify(reply);
    expect(encoded.includes(factText)).toBe(true);
    const result = recalledPage.safeParse(reply);
    if (!result.success) throw new Error('fixture_failed');
    local.state.reply = result.data.result.structuredContent.facts[0]!.text;
    delivered = true;
    return local.driver.dispatch(question, loaded, receive);
  }
  const driver = { ...local.driver, read, dispatch };
  const check = recallAnswerCheck(local.binding, local.reference, factText,
    'Recall my destination', driver);
  expect(await check()).toEqual({ result: 'PARTIAL', complete: false });
  expect(await check()).toEqual({ result: 'FAIL', reason: 'journey_failed', complete: false });
  expect(test.deliveries).toHaveLength(1);
  const rows = await history(test.setup.nats.store, 'conversation-chat', 'test');
  expect(JSON.stringify(rows).includes(factText)).toBe(false);
}
it('checks scripted native output against the real backend’s saved reference',
  checksStoredAnswer, 120_000);
