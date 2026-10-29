import { dirname } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { createEventStore } from '@opencrane/event-store';
import { history, MemberAccessRefused } from '@opencrane/models';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { computers, groups, memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { memoryAdmission } from '../src/chat/memory-admission.ts';
import { prepareInitialMemory } from '../src/memory/initial-delivery.ts';
import { initialQualificationFixture } from './support/initial-qualification.ts';
import type { MemoryOptions } from '../src/memory/access.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let options: MemoryOptions;
let deployment: Awaited<ReturnType<typeof initialQualificationFixture>>;
const claims = { silo: 'test', requester: 'alice', assistant: 'assistant', computer: 'computer',
  generation: 1, conversation: 'conversation', turn: 'turn', thread: 'thread' };
const scopeId = memoryScopeId('test', 'person', 'alice');
const runtime = { sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'synthetic-test' };
const qualification = { ...runtime, result: 'PASS', checks: { privateTurns: 'PASS',
  nativeRecall: 'PASS', requesterIsolation: 'PASS', sessionIsolation: 'PASS',
  invalidation: 'PASS', unrelatedActivity: 'PASS', stopReconnect: 'PASS',
  replacementReload: 'PASS', persistence: 'PASS' } };
const evidence = { runtime, qualification };
vi.mock('node:fs', async function filesystem(importOriginal) {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original };
});
vi.mock('node:child_process', async function processes(importOriginal) {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original };
});

const canary = 'Initial personal memory canary';
function memberId() {
  return Promise.resolve('alice');
}
async function start() {
  setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual', 'sales', 'restricted');
  await setup.stopDispatch();
  await setup.runtime.stop();
  const tool = toolEvidence({ name: 'recall', reviewed: true, costCents: 0 });
  await setup.append('mcp-memory', 'mcp.server_registered', { serverId: 'memory', kind: 'hosted',
    registeredBy: 'alice', locator: `registry.example.test/memory@sha256:${'a'.repeat(64)}` });
  await setup.append('mcp-memory', 'mcp.server_discovered', { serverId: 'memory',
    connectionId: 'server', accountMode: 'none', ...catalogueEvidence([tool]) });
  await reviewCatalogue(setup, 'memory');
  await setup.append('mcp-memory', 'mcp.tool_mode_set', { serverId: 'memory',
    connectionId: 'server', toolName: 'recall', toolRevision: tool.revision,
    mode: 'allow', setBy: 'alice' });
  await setup.append('mcp-memory', 'mcp.server_published', { serverId: 'memory', publishedBy: 'alice' });
  for (const [resourceType, resourceId] of [['mcp_server', 'memory'], ['memory_read', scopeId]]) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const saved = await setup.append(grantStream(resourceType!, resourceId!), 'grant.given',
        { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' });
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  options = { silo: 'test', store: setup.nats.store, db: setup.db, binding: setup.binding,
    keyDirectory: dirname(setup.options.configFile), feed: { memberId } };
  const keys = memoryKeys(options.keyDirectory!);
  for (const projection of [groups, computers, memoryProjection({ decrypt: keys.decrypt })]) {
    await setup.runner.initialise(projection);
    await setup.runner.run(projection);
  }
  deployment = await initialQualificationFixture();
  expect(deployment.result.result).toBe('PASS');
}
async function close() {
  vi.restoreAllMocks();
  await setup?.close();
}
beforeEach(start, 120_000);
afterEach(close);
async function fact(memoryId = 'fact', text = canary) {
  const keys = memoryKeys(options.keyDirectory!);
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId, revision: 1 };
  keys.provision(identity);
  await setup.append(`scope-${scopeId}`, 'memory.written', { scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId, revision: 1, schemaVersion: 1,
    kind: 'preference', pinned: true, expiresAt: null, sources: [], dependsOn: [],
    ...keys.encrypt(identity, text) });
  await setup.runner.run(memoryProjection({ decrypt: keys.decrypt }));
}
function prepare() {
  return prepareInitialMemory(options, claims);
}
async function state(store = options.store) {
  const chat = await readChatFacts(store, 'test', 'conversation', 'turn');
  return chat.memoryContext;
}
async function noQualification(qualification: unknown) {
  const before = await setup.nats.store.head();
  deployment.replace(qualification);
  await expect(prepareInitialMemory(options, claims)).rejects
    .toThrow('memory_context_unavailable');
  expect(await setup.nats.store.head()).toBe(before);
}
it.each([undefined, {}, { ...qualification, sourceSha: 'c'.repeat(40) },
  { ...qualification, checks: { privateTurns: 'PASS' } }])(
  'refuses absent, incomplete or mismatched qualification: %j', noQualification);
async function mismatch(patch: object) {
  await expect(prepareInitialMemory(options, { ...claims, ...patch })).rejects
    .toThrow('memory_context_unavailable');
  expect(await state()).toBeUndefined();
}
it.each([{ requester: 'bob' }, { assistant: 'other' }, { computer: 'other' },
  { generation: 2 }, { conversation: 'other' }, { turn: 'other' }, { thread: 'other' }])(
  'refuses substituted turn identity: %j', mismatch);
async function recordsBeforeRelease() {
  await fact();
  const pending = await prepare();
  expect(await state()).toMatchObject({ status: 'prepared', references: [] });
  const receipt = await pending.load();
  expect(receipt).toEqual({ status: 'loaded', dispatch: 'disabled' });
  expect(await state()).toMatchObject({ status: 'loaded', initialLoaded: true,
    references: [{ scopeId, memoryId: 'fact', revision: 1 }], executionAvailable: false });
  const cold = await createEventStore(setup.nats.connection);
  expect(await state(cold)).toEqual(await state());
  const rows = await history(cold, 'conversation-conversation', 'test');
  expect(JSON.stringify(rows)).not.toContain(canary);
  await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  await expect(prepare()).rejects.toThrow('memory_context_unavailable');
  expect(memoryAdmission.state).toBe('disabled');
}
it('records references once, returns no text and cold replay grants nothing', recordsBeforeRelease);
async function limits(count: number, text: string) {
  for (let index = 0; index < count; index++) await fact(`fact-${index}`, text);
  const pending = await prepare();
  await pending.load();
  const saved = await state();
  expect(saved?.initialBytes).toBeLessThanOrEqual(16384);
  expect(saved?.references.length).toBeLessThanOrEqual(32);
  expect(saved?.hasOmissions).toBe(count > 32 || text.length > 1000);
  if (count === 0) expect(saved?.references).toEqual([]);
  if (count === 33) expect(saved?.references).toHaveLength(32);
}
it.each([[0, ''], [33, 'short'], [5, '界'.repeat(1300)]] as const)(
  'records bounded initial selection (%i facts)', limits);
async function closure(action: string) {
  const append = options.store.append.bind(options.store);
  async function closeDuring(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const input = z.object({ data: z.object({ action: z.string().optional() }) });
    const data = input.parse(command.event).data;
    if (data.action === action) {
      await setup.append('participation-conversation', 'conversation.closed',
        { conversationId: 'conversation', closedBy: 'alice' });
    }
    return result;
  }
  vi.spyOn(options.store, 'append').mockImplementation(closeDuring);
  async function attempt() {
    const pending = await prepare();
    await pending.load();
  }
  await expect(attempt()).rejects.toThrow('memory_context_unavailable');
  expect((await state())?.executionAvailable).toBe(false);
}
it.each(['prepared', 'loaded'])('refuses closure during the %s append', closure);
async function lostAppend(action: string, saved: boolean) {
  await fact();
  const append = options.store.append.bind(options.store);
  async function lose(command: Parameters<typeof append>[0]) {
    const input = z.object({ data: z.object({ action: z.string().optional() }) });
    const data = input.parse(command.event).data;
    if (data.action !== action) return append(command);
    if (saved) await append(command);
    throw new Error('Private upstream error must not escape');
  }
  vi.spyOn(options.store, 'append').mockImplementation(lose);
  async function attempt() {
    const pending = await prepare();
    await pending.load();
  }
  await expect(attempt()).rejects.toThrow('memory_context_unavailable');
  if (saved) expect((await state())?.status).toBe(action);
  if (saved && action === 'loaded') {
    expect((await state())?.references).toEqual([{ scopeId, memoryId: 'fact', revision: 1 }]);
  }
}
it.each([['prepared', false], ['prepared', true], ['loaded', false], ['loaded', true]] as const)(
  'returns no text after an uncertain %s append (saved=%s)', lostAppend);
async function changedBeforeLoad(kind: string) {
  await fact();
  const pending = await prepare();
  if (kind === 'removed') {
    await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  } else if (kind === 'corrected') {
    const keys = memoryKeys(options.keyDirectory!);
    const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
      ownerId: 'alice', memoryId: 'fact', revision: 2 };
    keys.provision(identity);
    await setup.append(`scope-${scopeId}`, 'memory.corrected', { scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId: 'fact', revision: 2, schemaVersion: 1,
      expectedRevision: 1, supersedes: { memoryId: 'fact', revision: 1 }, reason: 'human',
      kind: 'preference', pinned: true, expiresAt: null, sources: [], dependsOn: [],
      ...keys.encrypt(identity, 'Replacement') });
  } else {
    const identity = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId: 'fact', expectedRevision: 1, revision: 2 };
    await setup.append(`scope-${scopeId}`, 'memory.forgotten', identity);
  }
  if (kind === 'removed') {
    await expect(pending.load()).rejects.toThrow(MemberAccessRefused);
  } else {
    await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  }
  expect((await state())?.initialLoaded).toBe(false);
}
it.each(['corrected', 'forgotten', 'removed'])('refuses %s facts before loading', changedBeforeLoad);

async function qualificationChanges() {
  const pending = await prepare();
  deployment.replace({ ...deployment.result, result: 'FAIL' });
  await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  expect((await state())?.initialLoaded).toBe(false);
}
it('refuses qualification withdrawn between commands', qualificationChanges);

async function historyBeforeAccess() {
  const readStream = options.store.readStream.bind(options.store);
  async function* inspect(...args: Parameters<typeof readStream>) {
    if (args[0] === 'conversation-conversation' && args[1] === 1) {
      expect(args[2]! - performance.now()).toBeGreaterThan(2000);
    }
    yield* readStream(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(inspect);
  const pending = await prepare();
  await setup.append('conversation-conversation', 'agent.turn_started', {
    assistantId: 'assistant', conversationId: 'conversation', turnId: 'unrelated' });
  await expect(pending.load()).resolves.toEqual({ status: 'loaded', dispatch: 'disabled' });
}
it('loads history outside the short check and permits unrelated turn activity', historyBeforeAccess);

async function memoryFree() {
  await setup.append('computer-assistant', 'computer.turn_started', { assistantId: 'assistant',
    computerId: 'computer', conversationId: 'conversation', turnId: 'free', threadId: 'free-thread',
    requesterId: 'alice', task: 'chat_turn', executionMode: 'memory_free' });
  const free = { ...claims, turn: 'free', thread: 'free-thread' };
  await expect(prepareInitialMemory(options, free)).rejects
    .toThrow('memory_context_unavailable');
}
it('does not upgrade a memory-free turn', memoryFree);

async function oneDecisionPerCommand() {
  await fact();
  const auth = memberAuthorisation(options.binding);
  const check = vi.spyOn(auth, 'check');
  const use = vi.spyOn(auth, 'use');
  const pending = await prepare();
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(use.mock.calls).toEqual([
    ['person', 'alice', 'mcp_server', 'memory'],
    ['assistant', 'assistant', 'mcp_server', 'memory'],
    ['person', 'alice', 'memory_read', scopeId],
    ['assistant', 'assistant', 'memory_read', scopeId],
  ]);
  check.mockClear();
  use.mockClear();
  await expect(pending.load()).resolves.toEqual({ status: 'loaded', dispatch: 'disabled' });
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(use).toHaveBeenCalledTimes(4);
  expect((await state())?.initialLoaded).toBe(true);
}
it('keeps one membership and permission decision per successful command', oneDecisionPerCommand);

async function removalBeforeCatalogueFailure() {
  await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  const read = options.store.readStream.bind(options.store);
  let catalogueRead = false;
  async function* unavailable(...args: Parameters<typeof read>) {
    if (args[0] === 'mcp-memory') {
      catalogueRead = true;
      throw new Error('Private catalogue failure');
    }
    yield* read(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(unavailable);
  await expect(prepare()).rejects.toThrow(MemberAccessRefused);
  expect(catalogueRead).toBe(false);
  expect(await state()).toBeUndefined();
}
it('keeps saved removal ahead of a catalogue outage', removalBeforeCatalogueFailure);

async function demotionDuringSnapshot() {
  const query = options.db.query.bind(options.db);
  let changed = false;
  async function demote(...args: Parameters<typeof query>) {
    const result = await query(...args);
    if (!changed && String(args[0]).includes('projection_generations')) {
      changed = true;
      const event = await setup.append('member-alice', 'member.role_changed', {
        memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'alice',
      });
      await setup.auth.handler.handle(event, setup.db);
    }
    return result;
  }
  vi.spyOn(options.db, 'query').mockImplementation(demote);
  await expect(prepare()).rejects.toThrow('memory_context_unavailable');
  expect(changed).toBe(true);
  expect(await state()).toBeUndefined();
}
it('refuses an applied demotion during the first snapshot read', demotionDuringSnapshot);

async function fabricatedQualification() {
  deployment.remove();
  await expect(prepareInitialMemory(options, claims, evidence)).rejects.toThrow('memory_context_unavailable');
  expect(await state()).toBeUndefined();
}
it('refuses matching caller PASS objects without deployment evidence', fabricatedQualification);

async function realCollectorShape() {
  const pending = await prepareInitialMemory(options, claims);
  await expect(pending.load()).resolves.toEqual({ status: 'loaded', dispatch: 'disabled' });
  expect((await state())?.initialLoaded).toBe(true);
}
it('accepts the real collector output from the protected deployment file', realCollectorShape);

async function staleCollector(kind: string) {
  if (kind === 'host') deployment.changeHost();
  if (kind === 'installation') deployment.changeInstallation();
  if (kind === 'incomplete') {
    deployment.replace({ ...deployment.result, qualifications: { 'P4-14': 'PASS' } });
  }
  await expect(prepare()).rejects.toThrow('memory_context_unavailable');
  expect(await state()).toBeUndefined();
}
it.each(['host', 'installation', 'incomplete'])(
  'refuses stale or incomplete deployment evidence: %s', staleCollector);
