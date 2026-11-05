import { setTimeout as delay } from 'node:timers/promises';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { recallBackend, factText, scopeId, threadId } from './support/recall-backend.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';

function createMockOptions() {
  return { spy: true };
}
const mockOptions = vi.hoisted(createMockOptions);
vi.mock('node:net', mockOptions);
async function filesystem() {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...original };
}
vi.mock('node:fs', filesystem);
async function processes() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...original };
}
vi.mock('node:child_process', processes);

async function recallsStoredFact() {
  const test = await recallBackend();
  await test.start();
  const before = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  expect(before.memoryContext?.initialLoaded).toBe(true);
  expect(before.memoryContext?.references).toEqual([]);
  expect(test.wire.paths).toEqual([]);
  const args = { scopeId, query: 'garden' };
  const poisoned = { 'x-memory-context': 'forged', 'x-turn-token': 'forged',
    'session-id': 'other-thread', 'x-requester-id': 'bob', 'x-memory-scope': 'other-scope' };
  const response = await test.native.recall(threadId, args, poisoned);
  const result = page.parse(response).result;
  const savedAt: unknown = expect.any(String);
  const expectedFact = { memoryId: 'garden', revision: 1, text: factText, kind: 'fact',
    pinned: false, expiresAt: null, savedAt };
  expect(result.content).toEqual([]);
  expect(result.structuredContent.facts).toEqual([expectedFact]);
  expect(result.structuredContent.scopeId).toBe(scopeId);
  expect(result.structuredContent.returnedCount).toBe(1);
  expect(result.structuredContent.nextCursor).toBeNull();
  expect(result.structuredContent.recallProof).toEqual(expect.any(String));
  const expectedReference = { scopeId, memoryId: 'garden', revision: 1 };
  const evidence = test.deliveries[0]?.memoryContext;
  expect(evidence?.references).toEqual([expectedReference]);
  expect(evidence?.recallCalls).toBe(1);
  expect(evidence?.recallBytes).toBe(Buffer.byteLength(JSON.stringify(response)));
  const expectedIdentity = { requester: 'alice', thread: threadId, scopes: [scopeId],
    conversation: 'chat', turn: test.turnId, authorizationPresent: false, turnPassPresent: false,
    sessionPresent: false, requesterHeaderPresent: false };
  expect(test.requests).toEqual([expectedIdentity]);
  const rows = await history(test.setup.nats.store, 'conversation-chat', 'test');
  expect(JSON.stringify(rows)).not.toContain(factText);
}
it('delivers a stored personal fact to the admitted native thread through the real backend',
  recallsStoredFact, 120_000);

const factShape = { memoryId: z.string(), revision: z.number(), text: z.string(),
  kind: z.literal('fact'), pinned: z.boolean(), expiresAt: z.null(), savedAt: z.string() };
const fact = z.strictObject(factShape);
const pageShape = { scopeId: z.string(), facts: z.array(fact),
  returnedCount: z.number(), nextCursor: z.string().nullable(), recallProof: z.string() };
const structuredContent = z.strictObject(pageShape);
const resultShape = { content: z.array(z.unknown()), structuredContent };
const result = z.object(resultShape);
const responseShape = { result };
const page = z.object(responseShape);

async function evidenceFailure(outcome: 'held' | 'denied' | 'unknown') {
  const test = await recallBackend();
  await test.start();
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  async function save(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.delivery === 'recall') {
      attempts += 1;
      entered.resolve();
      await release.promise;
      if (outcome === 'denied') {
        return { status: 'conflict' as const };
      }
      const saved = await append(command);
      expect(saved.status).toBe('appended');
      if (outcome === 'unknown') {
        return { status: 'unavailable' as const, cause: new Error('Reply lost') };
      }
      return saved;
    }
    return append(command);
  }
  vi.spyOn(store, 'append').mockImplementation(save);
  const args = { scopeId, query: 'garden' };
  const callId = 'evidence-call';
  const pending = test.native.recall(threadId, args, {}, callId);
  try {
    await entered.promise;
    await delay(25);
    expect(test.wire.results).toBe(0);
    expect(test.deliveries).toEqual([]);
  } finally {
    release.resolve();
  }
  const response = await pending;
  if (outcome === 'held') {
    expect(page.parse(response).result.structuredContent.facts).toHaveLength(1);
    expect(test.deliveries[0]?.memoryContext?.recallCalls).toBe(1);
  } else {
    const refused = { result: { isError: true } };
    expect(response).toMatchObject(refused);
    expect(JSON.stringify(response)).not.toContain(factText);
    expect(test.deliveries).toEqual([]);
  }
  const coldStore = { readStream: store.readStream.bind(store) };
  const saved = await readChatFacts(coldStore, 'test', 'chat', test.turnId);
  expect(saved.memoryContext?.recallCalls).toBe(outcome === 'denied' ? 0 : 1);
  if (outcome !== 'denied') {
    const duplicate = await test.native.recall(threadId, args, {}, callId);
    expect(JSON.stringify(duplicate)).not.toContain(factText);
    expect(duplicate).not.toHaveProperty('result.structuredContent');
  }
  expect(attempts).toBe(1);
}
it.each(['held', 'denied', 'unknown'] as const)(
  'returns no recall result before a proved evidence append: %s', evidenceFailure, 120_000);

async function limitsRecalls() {
  const test = await recallBackend();
  const text = 'Garden '.repeat(500);
  for (let index = 0; index < 5; index++) {
    await test.write(`large-${index}`, text);
  }
  await test.setup.runner.run(test.projection);
  await test.start();
  let totalBytes = 0;
  for (let index = 0; index < 4; index++) {
    const args = { scopeId, query: 'garden', limit: 5 };
    const response = await test.native.recall(threadId, args);
    const result = page.parse(response).result.structuredContent;
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeLessThan(5);
    expect(result.nextCursor).toEqual(expect.any(String));
    const bytes = Buffer.byteLength(JSON.stringify(response));
    expect(bytes).toBeLessThanOrEqual(16_384);
    totalBytes += bytes;
    expect(test.deliveries[index]?.memoryContext?.recallBytes).toBe(totalBytes);
  }
  expect(totalBytes).toBeLessThanOrEqual(65_536);
  const next = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, next);
  const refused = { result: { isError: true } };
  expect(response).toMatchObject(refused);
  expect(JSON.stringify(response)).not.toContain('Garden');
  expect(test.deliveries).toHaveLength(4);
  const saved = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  expect(saved.memoryContext?.recallCalls).toBe(4);
  expect(saved.memoryContext?.recallBytes).toBe(totalBytes);
}
it('keeps whole pages under 16 KiB, four replies and 64 KiB per native turn',
  limitsRecalls, 120_000);

async function limitsReferences() {
  const test = await recallBackend();
  for (let index = 0; index < 32; index++) {
    await test.write(`pin-${String(index).padStart(2, '0')}`, 'Pinned fact', true);
  }
  await test.setup.runner.run(test.projection);
  await test.start();
  const before = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  expect(before.memoryContext?.references).toHaveLength(32);
  const args = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, args);
  const refused = { result: { isError: true } };
  expect(response).toMatchObject(refused);
  expect(JSON.stringify(response)).not.toContain(factText);
  expect(test.deliveries).toEqual([]);
  const after = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  expect(after.memoryContext).toEqual(before.memoryContext);
}
it('refuses the thirty-third loaded reference before returning its fact',
  limitsReferences, 120_000);

async function isolatesSamePersonSessions() {
  const test = await recallBackend();
  await test.start();
  const secondThread = 'returned-native-2';
  const second = await test.admit('other-chat', secondThread);
  await second.start();
  expect(test.native.mcp.size).toBe(2);
  const args = { scopeId, query: 'garden' };
  const firstReply = await test.native.recall(threadId, args);
  const firstPage = page.parse(firstReply).result.structuredContent;
  expect(firstPage.facts[0]?.text).toBe(factText);
  const otherBefore = await readChatFacts(test.setup.nats.store, 'test', 'other-chat', second.turnId);
  expect(otherBefore.memoryContext?.recallCalls).toBe(0);
  expect(otherBefore.memoryContext?.references).toEqual([]);
  test.native.callers.remove(test.turnId);
  expect(test.native.mcp.size).toBe(1);
  const ended = await test.native.recall(threadId, args);
  expect(ended).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(ended)).not.toContain(factText);
  const secondReply = await test.native.recall(secondThread, args);
  const secondPage = page.parse(secondReply).result.structuredContent;
  expect(secondPage.facts).toEqual(firstPage.facts);
  const otherAfter = await readChatFacts(test.setup.nats.store, 'test', 'other-chat', second.turnId);
  expect(otherAfter.memoryContext?.recallCalls).toBe(1);
  expect(test.deliveries).toHaveLength(2);
}
it('keeps backend recall separate in two sessions belonging to the same person',
  isolatesSamePersonSessions, 120_000);

async function refusesWithdrawalDuringFinalQuery(change: 'stop' | 'removal' | 'closure' | 'replacement') {
  const test = await recallBackend();
  await test.start();
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  const query = test.setup.db.query.bind(test.setup.db);
  let loaded = false;
  let changed = false;
  async function observeAppend(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.delivery === 'recall') {
      expect(result.status).toBe('appended');
      loaded = true;
    }
    return result;
  }
  async function withdrawDuringQuery(...args: Parameters<typeof query>) {
    const result = await query(...args);
    if (loaded && !changed && String(args[0]).includes('projection_generations')) {
      changed = true;
      expect(test.wire.results).toBe(0);
      if (change === 'stop') {
        const data = { conversationId: 'chat', turnId: test.turnId, requestedBy: 'alice' };
        await test.setup.append('conversation-chat', 'agent.turn_stop_requested', data);
      } else if (change === 'removal') {
        const data = { memberId: 'alice', removedBy: 'alice' };
        await test.setup.append('member-alice', 'member.removed', data);
      } else if (change === 'replacement') {
        const data = { assistantId: 'assistant', computerId: 'computer',
          generation: 2, podUid: 'replacement' };
        await test.setup.append('computer-assistant', 'computer.ready', data);
      } else {
        const data = { conversationId: 'chat', closedBy: 'alice' };
        await test.setup.append('participation-chat', 'conversation.closed', data);
      }
      // Keep the caller registered to represent delayed withdrawal reactions.
      expect(test.native.callers.permits(test.turnId, test.turnId, threadId)).toBe(true);
    }
    return result;
  }
  vi.spyOn(store, 'append').mockImplementation(observeAppend);
  vi.spyOn(test.setup.db, 'query').mockImplementation(withdrawDuringQuery);
  const args = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, args);
  expect(changed).toBe(true);
  const refusal = { result: { isError: true } };
  expect(response).toMatchObject(refusal);
  expect(response).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(response)).not.toContain(factText);
  expect(test.deliveries).toEqual([]);
  const saved = await readChatFacts(store, 'test', 'chat', test.turnId);
  expect(saved.memoryContext?.recallCalls).toBe(1);
}
it.each(['stop', 'removal', 'closure', 'replacement'] as const)(
  'refuses recall when %s is saved during the final projection query',
  refusesWithdrawalDuringFinalQuery, 120_000);

async function refusesInvalidGrant(reason: 'expired' | 'cancelled') {
  const test = await recallBackend();
  await test.start();
  if (reason === 'cancelled') {
    await test.grant(threadId, 'chat', '', 0, test.turnId);
  }
  let expires = Date.now() + 60_000;
  if (reason === 'expired') {
    expires = Date.now() - 1;
  }
  await expect(test.grant(threadId, 'chat', 'replacement-pass', expires, test.turnId))
    .rejects.toThrow('refused');
}
it.each(['expired', 'cancelled'] as const)(
  'refuses a %s grant through the backend fixture control path', refusesInvalidGrant, 120_000);

async function expiresRenewedCatalogue() {
  const test = await recallBackend();
  await test.start();
  const firstExpiry = Date.now() + 200;
  await test.grant(threadId, 'chat', 'short-pass', firstExpiry, test.turnId);
  const renewedExpiry = Date.now() + 2000;
  await test.grant(threadId, 'chat', 'renewed-pass', renewedExpiry, test.turnId);
  await delay(Math.max(0, firstExpiry - Date.now()) + 25);
  expect(test.native.mcp.size).toBe(1);
  await delay(Math.max(0, renewedExpiry - Date.now()) + 25);
  expect(test.native.mcp.size).toBe(0);
  const args = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, args);
  expect(response).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(response)).not.toContain(factText);
  expect(test.wire.paths).toEqual([]);
}
it('renews the real catalogue timer and removes the catalogue at expiry',
  expiresRenewedCatalogue, 120_000);
