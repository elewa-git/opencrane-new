import { losslessJson } from '@opencrane/events/lossless-json';
import { memoryCorrectedEventSchema, memoryContextRecordedEventSchema } from '@opencrane/events';
import { history, authorityFence, prepareLoadedMemory, readToolPolicy } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from 'pg';
import { memoryScopeId, type Db } from '@opencrane/projections';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { subscribePrivateOutput } from '../src/chat/private-output.ts';
import { correctTool } from '../src/memory/mcp.ts';
import { readAgentChange } from '../src/memory/forget.ts';
import { memoryClock } from './support/memory-clock.ts';
import { commandReference } from '../src/memory/command-history.ts';
import { recallBackend, scopeId, threadId } from './support/recall-backend.ts';

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

const text = 'My walking destination is the summer garden.';
const contentShape = { recallProof: z.string() };
const contentSchema = z.object(contentShape);
const resultShape = { structuredContent: contentSchema };
const resultSchema = z.object(resultShape);
const responseShape = { result: resultSchema };
const responseSchema = z.object(responseShape);
type Backend = Awaited<ReturnType<typeof recallBackend>>;
async function correctionFixture() {
  const test = await recallBackend(true);
  await test.write('weather', 'The garden is sheltered.');
  await test.write('route', 'The garden path is short.');
  await test.setup.runner.run(test.projection);
  await test.start();
  const query = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, query);
  const parsed = responseSchema.parse(response);
  const recallProof = parsed.result.structuredContent.recallProof;
  const dependsOn = [{ scopeId, memoryId: 'route', revision: 1 },
    { scopeId, memoryId: 'weather', revision: 1 }];
  const args = { scopeId, commandId: 'native-correct', memoryId: 'garden', expectedRevision: 1,
    text, kind: 'fact', pinned: false, expiresAt: null, dependsOn, recallProof };
  return { ...test, args };
}

async function corrections(test: Backend) {
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  function isCorrection(row: typeof rows[number]) {
    return row.event.type === 'memory.corrected';
  }
  return rows.filter(isCorrection);
}

async function correctsLoadedTarget() {
  const test = await correctionFixture();
  const other = await test.admit('other-chat', 'returned-native-2');
  await other.start();
  const response = await test.native.call(threadId, 'correct', test.args);
  const rows = await corrections(test);
  expect(rows).toHaveLength(1);
  const saved = memoryCorrectedEventSchema.parse(rows[0]!.event);
  const receipt = { operation: 'correct', outcome: 'accepted', changeId: saved.id,
    memoryId: 'garden', revision: 2, scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: saved.time, contentStatus: 'current', cleanupStatus: 'pending' };
  const expected = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: receipt } };
  expect(response).toEqual(expected);
  const expectedData = { dependsOn: test.args.dependsOn, expectedRevision: 1, ownerId: 'alice' };
  expect(saved.data).toMatchObject(expectedData);
  expect(JSON.stringify(rows)).not.toContain(text);
  const claims = { silo: 'test', requester: 'alice', assistant: 'assistant', computer: 'computer',
    generation: 1, conversation: 'chat', turn: test.turnId, thread: threadId };
  const conversation = await history(test.setup.nats.store, 'conversation-chat', 'test');
  const loaded = await prepareLoadedMemory(test.setup.nats.store, test.setup.binding, claims,
    conversation, performance.now() + 10_000);
  const authority = await authorityFence(test.setup.nats.store, performance.now(), []);
  await expect(loaded.confirm(authority)).rejects.toThrow();
  const ownScope = { scopeId };
  const stale = await test.native.recall(threadId, ownScope);
  expect(stale).not.toHaveProperty('result.structuredContent');
  await test.setup.runner.run(test.projection);
  const freshQuery = { scopeId, query: 'summer' };
  const found = await test.native.recall('returned-native-2', freshQuery);
  expect(JSON.stringify(found)).toContain(text);
  expect(JSON.stringify(found)).toContain('"revision":2');
}
it('corrects the loaded target, keeps other references and refuses the old loaded turn',
  correctsLoadedTarget, 120_000);

async function lostCorrectionReply(expired: boolean) {
  const test = await correctionFixture();
  const clock = memoryClock();
  const savedReply = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = test.setup.nats.store.append.bind(test.setup.nats.store);
  let attempts = 0;
  async function loseReply(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    if (memoryCorrectedEventSchema.safeParse(command.event).success) {
      attempts += 1;
      expect(saved.status).toBe('appended');
      savedReply.resolve();
      await release.promise;
      return { status: 'unavailable' as const, cause: new Error('Reply lost') };
    }
    return saved;
  }
  vi.spyOn(test.setup.nats.store, 'append').mockImplementation(loseReply);
  const pending = test.native.call(threadId, 'correct', test.args);
  function endedBeforeSave(): never {
    throw new Error('Correct ended before saving its event');
  }
  try {
    await Promise.race([savedReply.promise, pending.then(endedBeforeSave)]);
    expect(await corrections(test)).toHaveLength(1);
    if (expired) {
      clock.advance(2001);
    }
  } finally {
    release.resolve();
  }
  const response = await pending;
  if (expired) {
    const message = 'The tool did not confirm a result. It may have received the request. '
      + 'OpenCrane will not send it again.';
    const expected = { jsonrpc: '2.0', id: 1,
      result: { isError: true, content: [{ type: 'text', text: message }] } };
    expect(response).toEqual(expected);
  } else {
    const expectedResponse = { result: { structuredContent: { outcome: 'unknown' } } };
    expect(response).toMatchObject(expectedResponse);
  }
  const rows = await corrections(test);
  const saved = memoryCorrectedEventSchema.parse(rows[0]!.event);
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'alice' };
  const status = await readAgentChange(test.memory, 'alice', scope, test.args.commandId);
  const expectedStatus = { operation: 'correct', outcome: 'accepted', changeId: saved.id,
    memoryId: 'garden', revision: 2, scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: saved.time, contentStatus: 'current', cleanupStatus: 'pending' };
  expect(status).toEqual(expectedStatus);
  const repeated = await readAgentChange(test.memory, 'alice', scope, test.args.commandId);
  expect(repeated).toEqual(status);
  expect(attempts).toBe(1);
  expect(await corrections(test)).toHaveLength(1);
  expect(JSON.stringify(status)).not.toContain(text);
}
it.each([false, true])('recovers the exact Correct receipt after a lost reply (expired=%s)',
  lostCorrectionReply, 120_000);

const refusals = ['revision', 'omitted', 'foreign', 'target', 'old-target', 'scope',
  'review', 'ask', 'block', 'qualification', 'caller', 'generation', 'thread',
  'forged-caller', 'forged-thread'] as const;
async function refusesCorrection(reason: typeof refusals[number]) {
  const test = await correctionFixture();
  const args = test.args;
  if (reason === 'revision') {
    args.expectedRevision = 2;
  }
  if (reason === 'omitted') {
    args.dependsOn.pop();
  }
  if (reason === 'foreign') {
    args.dependsOn[0]!.scopeId = memoryScopeId('test', 'person', 'bob');
  }
  if (reason === 'target' || reason === 'old-target') {
    const revision = reason === 'target' ? 1 : 2;
    const target = { scopeId, memoryId: 'garden', revision };
    args.dependsOn.push(target);
  }
  if (reason === 'scope') {
    args.scopeId = memoryScopeId('test', 'person', 'bob');
  }
  if (reason === 'qualification') {
    test.deployment.remove();
  }
  if (reason === 'caller') {
    test.native.callers.remove(test.turnId);
  }
  if (reason === 'generation') {
    const data = { assistantId: 'assistant', computerId: 'computer',
      generation: 2, podUid: 'replacement' };
    await test.setup.append('computer-assistant', 'computer.ready', data);
  }
  if (reason === 'ask' || reason === 'block') {
    const definition = JSON.stringify(correctTool);
    const data = { serverId: 'memory', connectionId: 'server', toolName: 'correct',
      toolRevision: losslessJson(definition).digest, mode: reason, setBy: 'alice' };
    await test.setup.append('mcp-memory', 'mcp.tool_mode_set', data);
  }
  if (reason === 'review') {
    const policy = await readToolPolicy(test.setup.nats.store, 'test', 'memory');
    const data = { serverId: 'memory', catalogueDigest: policy.catalogue!.schemaDigest,
      connectionId: 'server', accountMode: 'none', policyRevision: policy.policyRevision,
      reviewedBy: 'alice', tools: [] };
    await test.setup.append('mcp-memory', 'mcp.server_reviewed', data);
  }
  let thread = threadId;
  if (reason === 'thread') {
    thread = 'returned-native-2';
    const other = await test.admit('other-chat', thread);
    await other.start();
  }
  const identity: { caller?: string; threadId?: string } = {};
  if (reason === 'forged-caller') {
    identity.caller = 'forged';
  }
  if (reason === 'forged-thread') {
    identity.threadId = 'forged';
  }
  const response = await test.native.call(thread, 'correct', args, {}, reason, identity);
  await expectNoCorrection(test, response);
}
it.each(refusals)('refuses native Correct for %s', refusesCorrection, 120_000);

type Withdrawal = 'stop' | 'closure' | 'replacement' | 'removal' | 'qualification' | 'unrelated';
async function saveWithdrawal(test: Backend, change: Withdrawal) {
  if (change === 'stop' || change === 'unrelated') {
    const turnId = change === 'stop' ? test.turnId : 'another-turn';
    const data = { conversationId: 'chat', turnId, requestedBy: 'alice' };
    await test.setup.append('conversation-chat', 'agent.turn_stop_requested', data);
  }
  if (change === 'replacement') {
    const data = { assistantId: 'assistant', computerId: 'computer',
      generation: 2, podUid: 'replacement' };
    await test.setup.append('computer-assistant', 'computer.ready', data);
  }
  if (change === 'closure') {
    const data = { conversationId: 'chat', closedBy: 'alice' };
    await test.setup.append('conversation-chat', 'conversation.closed', data);
  }
  if (change === 'removal') {
    const data = { memberId: 'alice', removedBy: 'alice' };
    await test.setup.append('member-alice', 'member.removed', data);
  }
  if (change === 'qualification') {
    test.deployment.remove();
  }
  // Keep local withdrawal delayed so the saved change must refuse the write.
  expect(test.native.callers.permits(test.turnId, test.turnId, threadId)).toBe(true);
}
async function expectNoCorrection(test: Backend, response: unknown) {
  expect(await corrections(test)).toHaveLength(0);
  expect(response).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(response)).not.toContain(text);
}
async function checkWithdrawal(test: Backend, change: Withdrawal, response: unknown) {
  if (change === 'unrelated') {
    expect(await corrections(test)).toHaveLength(1);
    const expected = { result: { structuredContent: { outcome: 'accepted', revision: 2 } } };
    expect(response).toMatchObject(expected);
  } else {
    await expectNoCorrection(test, response);
  }
}

const withdrawals = ['stop', 'closure', 'replacement', 'removal', 'qualification', 'unrelated'] as const;
async function withdrawsDuringLock(change: Withdrawal) {
  const test = await correctionFixture();
  const reference = commandReference('test', scopeId, 'alice', test.args.commandId, 'agent');
  const lockName = `memory-command:${reference}`;
  const databaseLockName = `opencrane:projection:${lockName}`;
  const clientOptions = { connectionString: test.setup.databaseUrl };
  const client = new Client(clientOptions);
  await client.connect();
  const attempted = Promise.withResolvers<void>();
  const lock = test.memory.db.lock!.bind(test.memory.db);
  async function trackedLock<Result>(name: string, work: (db: Db) => Promise<Result>,
    options?: { timeoutMs: number; signal?: AbortSignal }) {
    const pending = lock(name, work, options);
    if (name === lockName) {
      attempted.resolve();
    }
    return pending;
  }
  const lockSpy = vi.spyOn(test.memory.db, 'lock');
  lockSpy.mockImplementation(trackedLock);
  let pending: Promise<unknown> | undefined;
  function finishedBeforeLock() {
    throw new Error('Correct finished before trying the PostgreSQL lock');
  }
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [databaseLockName]);
    pending = test.native.call(threadId, 'correct', test.args);
    await Promise.race([attempted.promise, pending.then(finishedBeforeLock)]);
    await saveWithdrawal(test, change);
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [databaseLockName]);
    await checkWithdrawal(test, change, await pending);
  } finally {
    await client.query('SELECT pg_advisory_unlock_all()');
    await client.end();
    await pending;
    lockSpy.mockRestore();
  }
}
it.each(withdrawals)('checks saved %s after waiting for the real database lock',
  withdrawsDuringLock, 120_000);

async function withdrawsAtAppend(change: Withdrawal) {
  const test = await correctionFixture();
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  let changed = false;
  async function withdraw(command: Parameters<typeof append>[0]) {
    if (memoryCorrectedEventSchema.safeParse(command.event).success) {
      changed = true;
      await saveWithdrawal(test, change);
    }
    return append(command);
  }
  vi.spyOn(store, 'append').mockImplementation(withdraw);
  const response = await test.native.call(threadId, 'correct', test.args);
  expect(changed).toBe(true);
  await checkWithdrawal(test, change, response);
}
it.each(withdrawals)('checks saved %s inside the final append callback',
  withdrawsAtAppend, 120_000);

const releaseChanges = [...withdrawals, 'deadline'] as const;
async function withdrawsAfterSave(change: typeof releaseChanges[number]) {
  const test = await correctionFixture();
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  const saved = Promise.withResolvers<number>();
  const acknowledge = Promise.withResolvers<void>();
  async function delayAcknowledgement(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (memoryCorrectedEventSchema.safeParse(command.event).success) {
      expect(result.status).toBe('appended');
      saved.resolve(command.deadline!);
      await acknowledge.promise;
    }
    return result;
  }
  vi.spyOn(store, 'append').mockImplementation(delayAcknowledgement);
  const pending = test.native.call(threadId, 'correct', test.args);
  function finishedBeforeSave(): never {
    throw new Error('Correct finished before saving the correction');
  }
  try {
    const deadline = await Promise.race([saved.promise, pending.then(finishedBeforeSave)]);
    expect(await corrections(test)).toHaveLength(1);
    if (change === 'deadline') {
      vi.spyOn(performance, 'now').mockReturnValue(deadline + 1);
    } else {
      await saveWithdrawal(test, change);
    }
    acknowledge.resolve();
    const response = await pending;
    expect(await corrections(test)).toHaveLength(1);
    if (change === 'unrelated') {
      const expected = { result: { structuredContent: { outcome: 'accepted', revision: 2 } } };
      expect(response).toMatchObject(expected);
    } else {
      const message = 'The tool did not confirm a result. It may have received the request. '
        + 'OpenCrane will not send it again.';
      const expected = { jsonrpc: '2.0', id: 1,
        result: { isError: true, content: [{ type: 'text', text: message }] } };
      expect(response).toEqual(expected);
    }
    expect(JSON.stringify(response)).not.toContain(text);
  } finally {
    acknowledge.resolve();
    await pending;
  }
}
it.each(releaseChanges)('checks %s before releasing a saved Correct receipt',
  withdrawsAfterSave, 120_000);

async function releasesOnlyCurrentOutput(correct: boolean) {
  const test = await correctionFixture();
  function current() {
    return true;
  }
  function confirm() {
    return Promise.resolve(true);
  }
  const subscriber = { store: test.setup.nats.store, silo: 'test', memberId: 'alice',
    conversationId: 'chat', socket: test.link.socket, current, confirm };
  subscribePrivateOutput(subscriber);
  const send = vi.spyOn(test.link.socket, 'send');
  const facts = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  const events = facts.memoryContext!.events.values();
  const recorded = events.next().value!;
  const evidence = memoryContextRecordedEventSchema.parse(JSON.parse(recorded)).data;
  const output = { type: 'private_reply', sequence: 2, previousSequence: 1,
    conversationId: 'chat', turnId: test.turnId, threadId, generation: 1,
    inputGeneration: evidence.inputGeneration, text };
  if (correct) {
    const response = await test.native.call(threadId, 'correct', test.args);
    const expected = { result: { structuredContent: { outcome: 'accepted' } } };
    expect(response).toMatchObject(expected);
  }
  const bytes = Buffer.from(JSON.stringify(output));
  test.link.socket.emit('message', bytes);
  async function ended() {
    const rows = await history(test.setup.nats.store, 'conversation-chat', 'test');
    function isCompletion(row: typeof rows[number]) {
      return row.event.type === 'agent.output_lost';
    }
    expect(rows.some(isCompletion)).toBe(true);
  }
  const waiting = { timeout: 5000 };
  await vi.waitFor(ended, waiting);
  await test.link.settled();
  expect(JSON.stringify(send.mock.calls).includes(text)).toBe(!correct);
}
it.each([false, true])('releases generated output only while its loaded revision is current: %s',
  releasesOnlyCurrentOutput, 120_000);
