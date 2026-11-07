import * as crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import { losslessJson } from '@opencrane/events/lossless-json';
import { memoryForgottenEventSchema, memoryContextRecordedEventSchema,
  memoryCleanupRecordedEventSchema } from '@opencrane/events';
import { history, authorityFence, prepareLoadedMemory, readToolPolicy } from '@opencrane/models';
import { expect, it, onTestFinished, vi } from 'vitest';
import Fastify from 'fastify';
import { encodeSession } from '@opencrane/auth';
import { registerMemoryCommands } from '../src/memory/commands-routes.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { memoryClock } from './support/memory-clock.ts';
import { z } from 'zod';
import { Client } from 'pg';
import { computers, groups, memoryScopeId, type Db } from '@opencrane/projections';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { subscribePrivateOutput } from '../src/chat/private-output.ts';
import { forgetTool } from '../src/memory/mcp.ts';
import * as forgetCommands from '../src/memory/forget.ts';
import { readAgentChange } from '../src/memory/forget.ts';
import { MemoryRefused, scopeAccess, scopeFor } from '../src/memory/access.ts';
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

async function cryptoModule() {
  const original = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...original };
}
vi.mock('node:crypto', cryptoModule);

const text = 'My favourite walking destination is the winter garden.';
const contentShape = { recallProof: z.string() };
const contentSchema = z.object(contentShape);
const resultShape = { structuredContent: contentSchema };
const resultSchema = z.object(resultShape);
const responseShape = { result: resultSchema };
const responseSchema = z.object(responseShape);
type Backend = Awaited<ReturnType<typeof recallBackend>>;
async function forgetFixture() {
  const test = await recallBackend(true);
  await test.write('unloaded', 'A separate fact.');
  await test.setup.runner.run(test.projection);
  // Keep fixture turn delivery within its access deadline on a busy host.
  const clock = memoryClock();
  try {
    await test.start();
  } finally {
    clock.restore();
  }
  const query = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, query);
  const parsed = responseSchema.parse(response);
  const recallProof = parsed.result.structuredContent.recallProof;
  const args = { scopeId, commandId: 'native-forget', memoryId: 'garden', expectedRevision: 1,
    recallProof };
  return { ...test, args };
}

async function tombstones(test: Backend) {
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  function isForget(row: typeof rows[number]) {
    return row.event.type === 'memory.forgotten';
  }
  return rows.filter(isForget);
}

async function forgetsLoadedTarget() {
  const test = await forgetFixture();
  const response = await test.native.call(threadId, 'forget', test.args);
  const rows = await tombstones(test);
  expect(rows).toHaveLength(1);
  const saved = memoryForgottenEventSchema.parse(rows[0]!.event);
  const receipt = { operation: 'forget', outcome: 'accepted', changeId: saved.id,
    memoryId: 'garden', revision: 2, scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: saved.time, hidden: true, cleanupStatus: 'pending' };
  const expected = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: receipt } };
  expect(response).toEqual(expected);
  const expectedData = { expectedRevision: 1, ownerId: 'alice' };
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
  const other = await test.admit('other-chat', 'returned-native-2');
  await other.start();
  const freshQuery = { scopeId, query: 'garden' };
  const found = await test.native.recall('returned-native-2', freshQuery);
  const empty = { result: { structuredContent: { facts: [] } } };
  expect(found).toMatchObject(empty);
  expect(JSON.stringify(found)).not.toContain(text);
}
it('forgets the loaded target and refuses old input while a fresh turn sees no fact',
  forgetsLoadedTarget, 120_000);

async function recoversForgetReceipt(lost: boolean) {
  const test = await forgetFixture();
  const append = test.setup.nats.store.append.bind(test.setup.nats.store);
  let attempts = 0;
  async function loseReply(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    if (memoryForgottenEventSchema.safeParse(command.event).success) {
      attempts += 1;
      expect(saved.status).toBe('appended');
      if (lost) {
        return { status: 'unavailable' as const, cause: new Error('Reply lost') };
      }
    }
    return saved;
  }
  vi.spyOn(test.setup.nats.store, 'append').mockImplementation(loseReply);
  const response = await test.native.call(threadId, 'forget', test.args);
  const outcome = lost ? 'unknown' : 'accepted';
  const expectedResponse = { result: { structuredContent: { outcome } } };
  expect(response).toMatchObject(expectedResponse);
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'alice' };
  const files = readdirSync(test.memory.keyDirectory);
  const decrypts = vi.spyOn(crypto, 'createDecipheriv');
  const status = await readAgentChange(test.memory, 'alice', scope, test.args.commandId);
  const rows = await tombstones(test);
  const saved = memoryForgottenEventSchema.parse(rows[0]!.event);
  const expectedStatus = { operation: 'forget', outcome: 'accepted', changeId: saved.id,
    memoryId: 'garden', revision: 2, scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: saved.time, hidden: true, cleanupStatus: 'pending' };
  expect(status).toEqual(expectedStatus);
  const repeated = await readAgentChange(test.memory, 'alice', scope, test.args.commandId);
  expect(repeated).toEqual(status);
  expect(decrypts).not.toHaveBeenCalled();
  decrypts.mockRestore();
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  const duplicate = await test.native.call(threadId, 'forget', test.args);
  expect(duplicate).not.toHaveProperty('result.structuredContent');
  const cleanup = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    changeId: saved.id, outcome: 'completed' };
  const event = { id: 'cleanup', commandId: 'cleanup', silo: 'test', subject: `scope-${scopeId}`,
    type: 'memory.cleanup_recorded', source: 'opencrane-worker', time: new Date().toISOString(),
    principal: { kind: 'system', id: 'opencrane-worker' }, correlation: {}, data: cleanup };
  const completed = memoryCleanupRecordedEventSchema.parse(event);
  await test.setup.nats.seed([completed]);
  const finished = await readAgentChange(test.memory, 'alice', scope, test.args.commandId);
  const expectedFinished = { ...expectedStatus, cleanupStatus: 'forgotten', forgottenAt: completed.time };
  expect(finished).toEqual(expectedFinished);
  expect(attempts).toBe(1);
  expect(await tombstones(test)).toHaveLength(1);
  expect(JSON.stringify(status)).not.toContain(text);
}
it.each([false, true])('recovers the exact Forget receipt without resending (lost=%s)',
  recoversForgetReceipt, 120_000);

async function recoveryRoute(test: Backend) {
  const app = Fastify();
  const config = testAuthConfig({ expectedOrgId: 'org-acme' });
  const member = { memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member' };
  const joined = await test.setup.append('member-bob', 'member.joined', member);
  await test.setup.auth.handler.handle(joined, test.setup.db);
  const team = { teamId: 'sales', name: 'Sales', createdBy: 'alice' };
  const created = await test.setup.append('team-sales', 'team.created', team);
  await test.setup.auth.handler.handle(created, test.setup.db);
  const membership = { teamId: 'sales', memberId: 'alice', addedBy: 'alice' };
  const added = await test.setup.append('team-sales', 'team.member_added', membership);
  await test.setup.auth.handler.handle(added, test.setup.db);
  await test.setup.runner.initialise(groups);
  await test.setup.runner.initialise(computers);
  await test.setup.runner.run(groups);
  await test.setup.runner.run(computers);
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const options = { ...test.memory, feed: { memberId } };
  registerMemoryCommands(app, config, options);
  await app.ready();
  async function closeRecovery() {
    await app.close();
  }
  onTestFinished(closeRecovery);
  function recover(requester: string, requestedScope = scopeId, commandId = 'native-forget') {
    const session = { sub: requester, orgId: 'org-acme', roles: ['member'],
      authTime: 1790856000, exp: 2000000000 };
    const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
    const url = `/api/memory/${requestedScope}/agent-changes/${commandId}`;
    const request = { method: 'GET' as const, url, headers: { cookie } };
    return app.inject(request);
  }
  return recover;
}

const recoveryRefusals = ['removed', 'foreign', 'shared'] as const;
async function refusesRecovery(reason: typeof recoveryRefusals[number]) {
  const test = await forgetFixture();
  memoryClock();
  const response = await test.native.call(threadId, 'forget', test.args);
  expect(response).toHaveProperty('result.structuredContent.outcome', 'accepted');
  const recover = await recoveryRoute(test);
  const control = await recover('alice');
  expect(control.statusCode, control.body).toBe(200);
  expect(control.json()).toHaveProperty('outcome', 'accepted');
  let requester = 'alice';
  let requestedScope = scopeId;
  if (reason === 'removed') {
    const removal = { memberId: 'alice', removedBy: 'alice' };
    await test.setup.append('member-alice', 'member.removed', removal);
  }
  if (reason === 'foreign') {
    requester = 'bob';
  }
  if (reason === 'shared') {
    requestedScope = memoryScopeId('test', 'group', 'sales');
  }
  const before = await test.setup.nats.store.head();
  const files = readdirSync(test.memory.keyDirectory);
  const appends = vi.spyOn(test.setup.nats.store, 'append');
  appends.mockClear();
  const decrypts = vi.spyOn(crypto, 'createDecipheriv');
  const keyBytes = vi.spyOn(crypto, 'randomBytes');
  const refused = await recover(requester, requestedScope);
  expect(refused.statusCode, refused.body).toBe(404);
  expect(refused.json()).toEqual({ status: 'refused' });
  expect(refused.body).not.toContain(text);
  expect(appends).not.toHaveBeenCalled();
  expect(await test.setup.nats.store.head()).toBe(before);
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  // Allow only the session cookie to be decrypted; never decrypt a memory value.
  expect(decrypts).toHaveBeenCalledTimes(1);
  expect(keyBytes).not.toHaveBeenCalledWith(32);
}
it.each(recoveryRefusals)('refuses authenticated Forget recovery for %s access',
  refusesRecovery, 120_000);

const helperRefusals = ['foreign owner', 'shared scope'] as const;
async function refusesRecoveryHelper(reason: typeof helperRefusals[number]) {
  const test = await recallBackend(true);
  const ownScope = scopeFor('test', 'person', 'alice');
  let refusedScope = scopeFor('test', 'person', 'bob');
  if (reason === 'shared scope') {
    // Keep the owner equal to the requester so only the scope-kind check refuses it.
    refusedScope = scopeFor('test', 'group', 'alice');
  }
  const commandId = 'helper-recovery';
  const base = { commandId, silo: 'test', type: 'memory.forgotten',
    source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'agent', id: 'alice' }, correlation: {} };
  for (const scope of [ownScope, refusedScope]) {
    const data = { schemaVersion: 1, ...scope, memoryId: 'garden', revision: 2,
      expectedRevision: 1 };
    const proposed = { ...base, id: `forgotten-${scope.scopeId}`,
      subject: `scope-${scope.scopeId}`, data };
    const event = memoryForgottenEventSchema.parse(proposed);
    await test.setup.nats.seed([event]);
  }
  const control = await readAgentChange(test.memory, 'alice', ownScope, commandId);
  const expected = { operation: 'forget', outcome: 'accepted',
    changeId: `forgotten-${ownScope.scopeId}`, memoryId: 'garden', revision: 2,
    scopeId: ownScope.scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: base.time, hidden: true, cleanupStatus: 'pending' };
  expect(control).toEqual(expected);
  const before = await test.setup.nats.store.head();
  const files = readdirSync(test.memory.keyDirectory);
  const appends = vi.spyOn(test.setup.nats.store, 'append');
  const decrypts = vi.spyOn(crypto, 'createDecipheriv');
  const keyBytes = vi.spyOn(crypto, 'randomBytes');
  const refused = readAgentChange(test.memory, 'alice', refusedScope, commandId);
  await expect(refused).rejects.toBeInstanceOf(MemoryRefused);
  expect(appends).not.toHaveBeenCalled();
  expect(await test.setup.nats.store.head()).toBe(before);
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  expect(decrypts).not.toHaveBeenCalled();
  expect(keyBytes).not.toHaveBeenCalled();
}
it.each(helperRefusals)('refuses the recovery helper for %s with a matching saved command',
  refusesRecoveryHelper, 120_000);

async function checksRecoveryRoutePermission() {
  const test = await recallBackend(true);
  const recover = await recoveryRoute(test);
  const sharedScope = scopeFor('test', 'group', 'sales');
  const access = await scopeAccess(test.memory, 'alice', sharedScope, true);
  const expectedAccess = { canRead: true, canWrite: true, canCorrect: false };
  expect(access).toMatchObject(expectedAccess);
  // Let the helper succeed so its separate owner check cannot hide a missing route check.
  const helper = vi.spyOn(forgetCommands, 'readAgentChange');
  const unknown = { outcome: 'unknown' };
  helper.mockResolvedValue(unknown);
  const control = await recover('alice');
  expect(control.statusCode, control.body).toBe(200);
  expect(control.json()).toEqual(unknown);
  const expectedOptions = { store: test.memory.store };
  const ownScope = scopeFor('test', 'person', 'alice');
  expect(helper).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(expectedOptions), 'alice', ownScope, 'native-forget');
  helper.mockClear();
  const before = await test.setup.nats.store.head();
  const files = readdirSync(test.memory.keyDirectory);
  const appends = vi.spyOn(test.setup.nats.store, 'append');
  const decrypts = vi.spyOn(crypto, 'createDecipheriv');
  const keyBytes = vi.spyOn(crypto, 'randomBytes');
  const refused = await recover('alice', sharedScope.scopeId);
  expect(refused.statusCode, refused.body).toBe(404);
  const expectedRefusal = { status: 'refused' };
  expect(refused.json()).toEqual(expectedRefusal);
  expect(helper).not.toHaveBeenCalled();
  expect(appends).not.toHaveBeenCalled();
  expect(await test.setup.nats.store.head()).toBe(before);
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  expect(decrypts).toHaveBeenCalledTimes(1);
  expect(keyBytes).not.toHaveBeenCalledWith(32);
}
it('checks canCorrect at the recovery route before calling the helper',
  checksRecoveryRoutePermission, 120_000);

async function isolatesRecoveryPrincipals() {
  const test = await forgetFixture();
  memoryClock();
  const recover = await recoveryRoute(test);
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'collision-only', revision: 2, expectedRevision: 1 };
  const base = { commandId: test.args.commandId, silo: 'test', subject: `scope-${scopeId}`,
    type: 'memory.forgotten', source: 'opencrane-server', time: new Date().toISOString(),
    correlation: {}, data };
  const human = { ...base, id: 'human-collision', principal: { kind: 'human', id: 'alice' } };
  const foreign = { ...base, id: 'agent-collision', principal: { kind: 'agent', id: 'bob' } };
  const events = [memoryForgottenEventSchema.parse(human), memoryForgottenEventSchema.parse(foreign)];
  await test.setup.nats.seed(events);
  const files = readdirSync(test.memory.keyDirectory);
  const before = await test.setup.nats.store.head();
  const appends = vi.spyOn(test.setup.nats.store, 'append');
  const decrypts = vi.spyOn(crypto, 'createDecipheriv');
  const keyBytes = vi.spyOn(crypto, 'randomBytes');
  const absent = await recover('alice');
  expect(absent.statusCode, absent.body).toBe(200);
  expect(absent.json()).toEqual({ outcome: 'unknown' });
  expect(appends).not.toHaveBeenCalled();
  expect(await test.setup.nats.store.head()).toBe(before);
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  expect(decrypts).toHaveBeenCalledTimes(1);
  expect(keyBytes).not.toHaveBeenCalledWith(32);
  keyBytes.mockRestore();
  decrypts.mockRestore();
  appends.mockRestore();
  const response = await test.native.call(threadId, 'forget', test.args);
  expect(response).toHaveProperty('result.structuredContent.outcome', 'accepted');
  const rows = await tombstones(test);
  const saved = memoryForgottenEventSchema.parse(rows.at(-1)!.event);
  const afterSave = await test.setup.nats.store.head();
  const statusAppends = vi.spyOn(test.setup.nats.store, 'append');
  const statusDecrypts = vi.spyOn(crypto, 'createDecipheriv');
  const statusKeyBytes = vi.spyOn(crypto, 'randomBytes');
  const status = await recover('alice');
  const expected = { operation: 'forget', outcome: 'accepted', changeId: saved.id,
    memoryId: 'garden', revision: 2, scopeId, audience: { kind: 'person', ownerId: 'alice' },
    acceptedAt: saved.time, hidden: true, cleanupStatus: 'pending' };
  expect(status.json()).toEqual(expected);
  expect(statusAppends).not.toHaveBeenCalled();
  expect(await test.setup.nats.store.head()).toBe(afterSave);
  expect(readdirSync(test.memory.keyDirectory)).toEqual(files);
  expect(statusDecrypts).toHaveBeenCalledTimes(1);
  expect(statusKeyBytes).not.toHaveBeenCalledWith(32);
}
it('isolates authenticated recovery from human and other agent command id collisions',
  isolatesRecoveryPrincipals, 120_000);

const refusals = ['revision', 'proof', 'unloaded', 'scope',
  'review', 'ask', 'block', 'qualification', 'caller', 'generation', 'thread',
  'forged-caller', 'forged-thread'] as const;
async function refusesForget(reason: typeof refusals[number]) {
  const test = await forgetFixture();
  const args = test.args;
  if (reason === 'revision') {
    args.expectedRevision = 2;
  }
  if (reason === 'proof') {
    args.recallProof = 'forged';
  }
  if (reason === 'unloaded') {
    args.memoryId = 'unloaded';
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
    const definition = JSON.stringify(forgetTool);
    const data = { serverId: 'memory', connectionId: 'server', toolName: 'forget',
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
  const response = await test.native.call(thread, 'forget', args, {}, reason, identity);
  await expectNoForget(test, response);
}
it.each(refusals)('refuses native Forget for %s', refusesForget, 120_000);

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
async function expectNoForget(test: Backend, response: unknown) {
  expect(await tombstones(test)).toHaveLength(0);
  expect(response).not.toHaveProperty('result.structuredContent');
  expect(JSON.stringify(response)).not.toContain(text);
}
async function checkWithdrawal(test: Backend, change: Withdrawal, response: unknown) {
  if (change === 'unrelated') {
    expect(await tombstones(test)).toHaveLength(1);
    const expected = { result: { structuredContent: { outcome: 'accepted', revision: 2 } } };
    expect(response).toMatchObject(expected);
  } else {
    await expectNoForget(test, response);
  }
}

const withdrawals = ['stop', 'closure', 'replacement', 'removal', 'qualification', 'unrelated'] as const;
async function withdrawsDuringLock(change: Withdrawal) {
  const test = await forgetFixture();
  if (change === 'unrelated') {
    // Keep a slow database lock from spending the acceptance deadline.
    memoryClock();
  }
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
    throw new Error('Forget finished before trying the PostgreSQL lock');
  }
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [databaseLockName]);
    pending = test.native.call(threadId, 'forget', test.args);
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
  const test = await forgetFixture();
  if (change === 'unrelated') {
    // Let the unrelated event save without spending the acceptance deadline.
    memoryClock();
  }
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  let changed = false;
  async function withdraw(command: Parameters<typeof append>[0]) {
    if (memoryForgottenEventSchema.safeParse(command.event).success) {
      changed = true;
      await saveWithdrawal(test, change);
    }
    return append(command);
  }
  vi.spyOn(store, 'append').mockImplementation(withdraw);
  const response = await test.native.call(threadId, 'forget', test.args);
  expect(changed).toBe(true);
  await checkWithdrawal(test, change, response);
}
it.each(withdrawals)('checks saved %s inside the final append callback',
  withdrawsAtAppend, 120_000);

const releaseChanges = [...withdrawals, 'deadline'] as const;
async function withdrawsAfterSave(change: typeof releaseChanges[number]) {
  const test = await forgetFixture();
  if (change === 'unrelated') {
    // Let the unrelated event finish without spending the receipt deadline.
    memoryClock();
  }
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  const saved = Promise.withResolvers<number>();
  const acknowledge = Promise.withResolvers<void>();
  async function delayAcknowledgement(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (memoryForgottenEventSchema.safeParse(command.event).success) {
      expect(result.status).toBe('appended');
      saved.resolve(command.deadline!);
      await acknowledge.promise;
    }
    return result;
  }
  vi.spyOn(store, 'append').mockImplementation(delayAcknowledgement);
  const pending = test.native.call(threadId, 'forget', test.args);
  function finishedBeforeSave(): never {
    throw new Error('Forget finished before saving the tombstone');
  }
  try {
    const deadline = await Promise.race([saved.promise, pending.then(finishedBeforeSave)]);
    expect(await tombstones(test)).toHaveLength(1);
    if (change === 'deadline') {
      vi.spyOn(performance, 'now').mockReturnValue(deadline + 1);
    } else {
      await saveWithdrawal(test, change);
    }
    acknowledge.resolve();
    const response = await pending;
    expect(await tombstones(test)).toHaveLength(1);
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
it.each(releaseChanges)('checks %s before releasing a saved Forget receipt',
  withdrawsAfterSave, 120_000);

async function qualificationDuringConfirmation(withdraw: boolean) {
  const test = await forgetFixture();
  // Keep the race about qualification rather than elapsed time on the shared host.
  memoryClock();
  const store = test.setup.nats.store;
  const append = store.append.bind(store);
  const readStream = store.readStream.bind(store);
  let saved = false;
  let held = false;
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function observeSave(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (memoryForgottenEventSchema.safeParse(command.event).success) {
      expect(result.status).toBe('appended');
      saved = true;
    }
    return result;
  }
  async function* holdConfirmation(...args: Parameters<typeof readStream>) {
    yield* readStream(...args);
    if (saved && !held && args[0] === 'conversation-chat') {
      expect(args[1]).toBeGreaterThan(1);
      held = true;
      reading.resolve();
      await release.promise;
    }
  }
  vi.spyOn(store, 'append').mockImplementation(observeSave);
  vi.spyOn(store, 'readStream').mockImplementation(holdConfirmation);
  const pending = test.native.call(threadId, 'forget', test.args);
  function endedBeforeRead(): never {
    throw new Error('Forget finished before its post-save confirmation read');
  }
  try {
    await Promise.race([reading.promise, pending.then(endedBeforeRead)]);
    expect(await tombstones(test)).toHaveLength(1);
    if (withdraw) {
      test.deployment.remove();
    }
    release.resolve();
    const response = await pending;
    if (withdraw) {
      const message = 'The tool did not confirm a result. It may have received the request. '
        + 'OpenCrane will not send it again.';
      const expected = { jsonrpc: '2.0', id: 1,
        result: { isError: true, content: [{ type: 'text', text: message }] } };
      expect(response).toEqual(expected);
    } else {
      expect(response).toHaveProperty('result.structuredContent.outcome', 'accepted');
    }
    expect(await tombstones(test)).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain(text);
  } finally {
    release.resolve();
    await pending;
  }
}
it.each([false, true])('checks qualification withdrawn during post-save access reads: %s',
  qualificationDuringConfirmation, 120_000);

async function releasesOnlyCurrentOutput(forgotten: boolean) {
  const test = await forgetFixture();
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
  if (forgotten) {
    // Wait for the saved tombstone before allowing its acknowledgement to return.
    memoryClock();
    const store = test.setup.nats.store;
    const append = store.append.bind(store);
    const saved = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    async function holdAcknowledgement(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      if (memoryForgottenEventSchema.safeParse(command.event).success) {
        expect(result.status).toBe('appended');
        saved.resolve();
        await acknowledge.promise;
      }
      return result;
    }
    vi.spyOn(store, 'append').mockImplementation(holdAcknowledgement);
    const pending = test.native.call(threadId, 'forget', test.args);
    function finishedBeforeSave(): never {
      throw new Error('Forget finished before saving the tombstone');
    }
    try {
      await Promise.race([saved.promise, pending.then(finishedBeforeSave)]);
      expect(await tombstones(test)).toHaveLength(1);
    } finally {
      acknowledge.resolve();
    }
    const response = await pending;
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
  expect(JSON.stringify(send.mock.calls).includes(text)).toBe(!forgotten);
}
it.each([false, true])('releases generated output only while its loaded revision is current: %s',
  releasesOnlyCurrentOutput, 120_000);
