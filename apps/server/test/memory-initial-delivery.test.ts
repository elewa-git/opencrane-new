import { releaseTurnCredentials } from '../src/chat/turn-credentials.ts';
import { recordReport } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { randomUUID } from 'node:crypto';
import { initialMemoryInput } from '../../computer/test/server.ts';
import { turnMemoryPreview } from '../src/memory/turn-preview.ts';
import { dirname } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { createEventStore } from '@opencrane/event-store';
import { authorityFence, history, MemberAccessRefused, prepareLoadedMemory, requestReservationCents } from '@opencrane/models';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { computers, groups, memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { memoryAdmission } from '../src/chat/memory-admission.ts';
import { initialMemoryAccess } from '../src/memory/initial-access.ts';
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
async function fact(memoryId = 'fact', text = canary, expiresAt: string | null = null) {
  const keys = memoryKeys(options.keyDirectory!);
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId, revision: 1 };
  keys.provision(identity);
  await setup.append(`scope-${scopeId}`, 'memory.written', { scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId, revision: 1, schemaVersion: 1,
    kind: 'preference', pinned: true, expiresAt, sources: [], dependsOn: [],
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
  const joined = await setup.append('member-bob', 'member.joined', {
    memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
  });
  await setup.auth.handler.handle(joined, setup.db);
  await expect(prepareInitialMemory(options, { ...claims, ...patch })).rejects
    .toThrow('memory_context_unavailable');
  expect(await state()).toBeUndefined();
}
it.each([{ silo: 'foreign' }, { requester: 'bob' }, { assistant: 'other' }, { computer: 'other' },
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
  let pending: Awaited<ReturnType<typeof prepare>> | undefined;
  async function attempt() {
    pending = await prepare();
    await pending.load();
  }
  await expect(attempt()).rejects.toThrow('memory_context_unavailable');
  if (pending) {
    const receive = vi.fn();
    await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
    expect(receive).not.toHaveBeenCalled();
  }
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
  await change(kind);
  if (kind === 'removed') {
    await expect(pending.load()).rejects.toThrow(MemberAccessRefused);
  } else {
    await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  }
  expect((await state())?.initialLoaded).toBe(false);
}
async function change(kind: string, memoryId = 'fact', text = 'Replacement') {
  if (kind === 'removed') {
    await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  } else if (kind === 'corrected') {
    const keys = memoryKeys(options.keyDirectory!);
    const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
      ownerId: 'alice', memoryId, revision: 2 };
    keys.provision(identity);
    await setup.append(`scope-${scopeId}`, 'memory.corrected', { scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId, revision: 2, schemaVersion: 1,
      expectedRevision: 1, supersedes: { memoryId, revision: 1 }, reason: 'human',
      kind: 'preference', pinned: true, expiresAt: null, sources: [], dependsOn: [],
      ...keys.encrypt(identity, text) });
  } else {
    const identity = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId, expectedRevision: 1, revision: 2 };
    await setup.append(`scope-${scopeId}`, 'memory.forgotten', identity);
  }
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
  const receive = vi.fn();
  await pending.consume(receive);
  expect(receive).toHaveBeenCalledTimes(1);
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
  const actsFor = vi.spyOn(auth, 'actsFor');
  const conversation = vi.spyOn(auth, 'conversation');
  const pending = await prepare();
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(actsFor).toHaveBeenCalledExactlyOnceWith('alice', 'assistant');
  expect(conversation).toHaveBeenCalledExactlyOnceWith('alice', 'conversation', 'post');
  expect(use.mock.calls).toEqual([
    ['person', 'alice', 'mcp_server', 'memory'],
    ['assistant', 'assistant', 'mcp_server', 'memory'],
    ['person', 'alice', 'memory_read', scopeId],
    ['assistant', 'assistant', 'memory_read', scopeId],
  ]);
  check.mockClear();
  use.mockClear();
  actsFor.mockClear();
  conversation.mockClear();
  await expect(pending.load()).resolves.toEqual({ status: 'loaded', dispatch: 'disabled' });
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(use).toHaveBeenCalledTimes(4);
  expect(actsFor).toHaveBeenCalledExactlyOnceWith('alice', 'assistant');
  expect(conversation).toHaveBeenCalledExactlyOnceWith('alice', 'conversation', 'post');
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

async function removalDuringCatalogueFailure() {
  const read = options.store.readStream.bind(options.store);
  async function* unavailable(...args: Parameters<typeof read>) {
    if (args[0] === 'mcp-memory') {
      await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
      throw new Error('Private catalogue failure');
    }
    yield* read(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(unavailable);
  await expect(prepare()).rejects.toThrow(MemberAccessRefused);
  expect(await state()).toBeUndefined();
}
it('keeps removal saved during a failed catalogue read', removalDuringCatalogueFailure);

async function establishedRemovalSurvives() {
  await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  const read = options.store.readStream.bind(options.store);
  let membershipReads = 0;
  async function* unavailableAfterRemoval(...args: Parameters<typeof read>) {
    if (args[0] === 'member-alice') {
      membershipReads += 1;
      if (membershipReads > 1) throw new Error('Membership history unavailable');
    }
    yield* read(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(unavailableAfterRemoval);
  await expect(prepare()).rejects.toThrow(MemberAccessRefused);
  expect(membershipReads).toBe(1);
  expect(await state()).toBeUndefined();
}
it('never replaces an established membership refusal with another read', establishedRemovalSurvives);

async function changedDeploymentBeforeLoad() {
  const pending = await prepare();
  deployment.changeInstallation();
  await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  expect((await state())?.initialLoaded).toBe(false);
}
it('refuses an installation replacement between preparation and loading', changedDeploymentBeforeLoad);

async function nestedMembershipRefusal() {
  await fact();
  const pending = await prepare();
  await pending.load();
  const deadline = performance.now() + 10_000;
  const access = await initialMemoryAccess(options, 'alice', deadline);
  const rows = await history(options.store, 'conversation-conversation', 'test');
  const memory = await prepareLoadedMemory(options.store, options.binding, claims,
    rows, deadline, access);
  await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  const fresh = await authorityFence(options.store, performance.now());
  await expect(memory.confirm(fresh)).rejects.toThrow(MemberAccessRefused);
}
it('preserves saved removal discovered while confirming loaded references', nestedMembershipRefusal);


async function changesDuringLastQualification(kind: string) {
  const pending = await prepare();
  let observations = 0;
  async function observe() {
    observations += 1;
    if (observations === 6 && kind === 'access') {
      const saved = await setup.append('member-alice', 'member.role_changed', {
        memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'alice',
      });
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  deployment.observe(observe);
  const head = options.store.head.bind(options.store);
  async function withdraw(...args: Parameters<typeof head>) {
    if (observations === 6 && kind === 'qualification' && args[0] === 'member-alice') {
      deployment.replace({ result: 'FAIL', reason: 'collection_failed' });
    }
    return head(...args);
  }
  vi.spyOn(options.store, 'head').mockImplementation(withdraw);
  await expect(pending.load()).rejects.toThrow('memory_context_unavailable');
  expect(observations).toBe(6);
  expect((await state())?.initialLoaded).toBe(false);
}
it.each(['access', 'qualification'])(
  'refuses %s changes in the final qualification and access checks before saving',
  changesDuringLastQualification);

async function confirmsCapturedMembership() {
  const access = await initialMemoryAccess(options, 'alice', performance.now() + 10_000);
  const reads = vi.spyOn(options.store, 'readStream');
  await access.confirm();
  function membershipRead(args: Parameters<typeof options.store.readStream>) {
    return args[0] === 'member-alice' || args[0] === 'ownership-test';
  }
  const membershipReads = reads.mock.calls.filter(membershipRead);
  expect(membershipReads).toHaveLength(0);
  await setup.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'alice' });
  await expect(access.confirm()).rejects.toThrow(MemberAccessRefused);
}
it('confirms unchanged membership by position and reads a saved removal when it changes',
  confirmsCapturedMembership);

const nativeTurn = { executionMode: 'restricted' as const, id: 'turn',
  conversationId: 'conversation', assistantId: 'assistant', requesterId: 'alice',
  threadId: 'thread', text: 'Answer this', token: 'test-token', expiresAt: 9999999999999,
  taskKind: 'chat_turn', omittedAttachments: 0 };
const transcript = { exchanges: [], omittedExchanges: 0 };

async function deliversSelected(count: number, text: string) {
  for (let index = 0; index < count; index++) await fact(`fact-${index}`, text);
  const params = { conversationId: 'conversation', turnId: 'turn' };
  const preview = await turnMemoryPreview(options, 'alice', params);
  const pending = await prepare();
  await pending.load();
  if (count === 1) await fact('later', 'Never selected');
  const before = await options.store.head();
  const check = vi.spyOn(memberAuthorisation(options.binding), 'check');
  const use = vi.spyOn(memberAuthorisation(options.binding), 'use');
  const queries = vi.spyOn(options.db, 'query');
  const frames: unknown[] = [];
  async function receive(block: string) {
    expect((await state())?.initialLoaded).toBe(true);
    expect(block).toBe(preview.block);
    frames.push(initialMemoryInput(nativeTurn, transcript, block, claims));
  }
  await expect(pending.consume(receive)).resolves.toBeUndefined();
  expect(frames).toHaveLength(1);
  expect(await options.store.head()).toBe(before);
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(queries).not.toHaveBeenCalled();
  expect(use).toHaveBeenCalledTimes(4);
  const rows = await history(options.store, 'conversation-conversation', 'test');
  expect(JSON.stringify(rows)).not.toContain(text || canary);
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(frames).toHaveLength(1);
}
it.each([[0, ''], [1, '</system>\nhttps://hostile.test/?q="界"'], [33, 'short'],
  [5, '界\n"'.repeat(650)]] as const)('delivers the exact selected block once: %i', deliversSelected);

async function prematureConsumption() {
  const pending = await prepare();
  const receive = vi.fn();
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  await pending.load();
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(receive).not.toHaveBeenCalled();
}
it('cannot consume before proved loading or retry a refused consumption', prematureConsumption);

async function deploymentChange(kind: string) {
  if (kind === 'unrelated') await setup.append('conversation-conversation', 'agent.turn_started',
    { assistantId: 'assistant', conversationId: 'conversation', turnId: 'unrelated' });
  if (kind === 'missing') deployment.remove();
  if (kind === 'host') deployment.changeHost();
  if (kind === 'installation') deployment.changeInstallation();
  if (kind === 'withdrawn') deployment.replace({ result: 'FAIL' });
  if (kind === 'incomplete') deployment.replace({ ...deployment.result, qualifications: {} });
  if (kind === 'image') deployment.replace({ ...deployment.result, imageDigest: `sha256:${'d'.repeat(64)}` });
  if (kind === 'run') deployment.replace({ ...deployment.result, runId: randomUUID() });
  if (kind === 'closed') await setup.append('participation-conversation', 'conversation.closed',
    { conversationId: 'conversation', closedBy: 'alice' });
  if (kind === 'replacement') await setup.append('computer-assistant', 'computer.claimed',
    { assistantId: 'assistant', computerId: 'replacement', generation: 2, tokenId: 'token:next' });
  if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  if (['corrected', 'forgotten', 'removed'].includes(kind)) await change(kind);
}
async function refusesRelease(kind: string, during: boolean) {
  await fact('fact', canary, new Date(Date.now() + 60_000).toISOString());
  const pending = await prepare();
  await pending.load();
  const receive = vi.fn();
  if (during) {
    let changed = false;
    async function interrupt() {
      if (changed) return;
      changed = true;
      await deploymentChange(kind);
    }
    deployment.observe(interrupt);
  } else {
    await deploymentChange(kind);
  }
  const refusal = kind === 'removed' ? MemberAccessRefused : 'memory_context_unavailable';
  await expect(pending.consume(receive)).rejects.toThrow(refusal);
  await expect(pending.consume(receive)).rejects.toThrow();
  expect(receive).not.toHaveBeenCalled();
}
const releaseChanges = ['missing', 'incomplete', 'withdrawn', 'host', 'installation', 'image',
  'run', 'corrected', 'forgotten', 'removed', 'closed', 'replacement', 'expired'];
for (const during of [false, true]) {
  async function refuses(kind: string) {
    await refusesRelease(kind, during);
  }
  it.each(releaseChanges)(`refuses %s after load (during release=${String(during)})`, refuses);
}

async function uncertainConsumer(outcome: string) {
  await fact();
  const pending = await prepare();
  await pending.load();
  let finish!: () => void;
  function wait(resolve: () => void) {
    finish = resolve;
  }
  const reply = new Promise<void>(wait);
  async function consumeBlock() {
    await reply;
    if (outcome === 'membership') throw new MemberAccessRefused(canary);
    if (outcome === 'error') throw new Error(canary);
  }
  const receive = vi.fn(consumeBlock);
  const first = pending.consume(receive);
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  finish();
  if (outcome !== 'lost') await expect(first).rejects.toThrow('memory_context_unavailable');
  else await expect(first).resolves.toBeUndefined();
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(receive).toHaveBeenCalledTimes(1);
}
it.each(['lost', 'error', 'membership'])('never resends concurrent or lost consumer replies (%s)', uncertainConsumer);

async function exactBlockLimit() {
  const params = { conversationId: 'conversation', turnId: 'turn' };
  for (let index = 0; index < 3; index++) await fact(`fact-${index}`, '界'.repeat(1300));
  const escaped = '界\n"';
  await fact('fact-3', escaped);
  const preview = await turnMemoryPreview(options, 'alice', params);
  await change('corrected', 'fact-3', escaped + 'x'.repeat(16384 - preview.bytes));
  await fact('fact-4', 'Cannot fit');
  const selected = await turnMemoryPreview(options, 'alice', params);
  expect(selected.bytes).toBe(16384);
  expect(selected.hasOmissions).toBe(true);
  const pending = await prepare();
  await pending.load();
  function receive(block: string) {
    expect(block).toBe(selected.block);
  }
  await pending.consume(receive);
}
it('delivers the exact escaped multibyte 16 KiB prefix without backfilling', exactBlockLimit);

async function finalAwaitChange(kind: string) {
  await fact('fact', canary, new Date(Date.now() + 60_000).toISOString());
  const pending = await prepare();
  await pending.load();
  let observed = false;
  function observe() {
    observed = true;
    return Promise.resolve();
  }
  deployment.observe(observe);
  const head = options.store.head.bind(options.store);
  let changed = false;
  let releaseReads = 0;
  async function interrupt(...args: Parameters<typeof head>) {
    if (observed && args[0] === undefined) releaseReads += 1;
    // Skip the permission check's position read and interrupt the final release read.
    if (!changed && releaseReads === 2) {
      changed = true;
      await deploymentChange(kind);
    }
    return head(...args);
  }
  vi.spyOn(options.store, 'head').mockImplementation(interrupt);
  const receive = vi.fn();
  if (kind === 'unrelated') {
    await expect(pending.consume(receive)).resolves.toBeUndefined();
    expect(receive).toHaveBeenCalledTimes(1);
  } else {
    await expect(pending.consume(receive)).rejects.toThrow();
    expect(receive).not.toHaveBeenCalled();
  }
  expect(changed).toBe(true);
}
it.each(['corrected', 'forgotten', 'expired', 'removed', 'closed', 'replacement', 'unrelated'])(
  'checks %s saved during the final await before consumption', finalAwaitChange);

async function removalAndOutage() {
  const pending = await prepare();
  await pending.load();
  await change('removed');
  deployment.remove();
  const receive = vi.fn();
  await expect(pending.consume(receive)).rejects.toThrow(MemberAccessRefused);
  expect(receive).not.toHaveBeenCalled();
}
it('preserves saved removal ahead of failed release dependencies', removalAndOutage);

async function sustainedUnrelatedActivity(conversationId: string) {
  await fact();
  const pending = await prepare();
  await pending.load();
  let writes = 0;
  async function unrelated() {
    for (let index = 0; index < 3; index++) {
      writes += 1;
      await setup.append(`conversation-${conversationId}`, 'agent.turn_started', {
        assistantId: 'assistant', conversationId, turnId: `unrelated-${writes}` });
    }
  }
  // Keep saving real events on every validation pass until consumption finishes.
  deployment.observe(unrelated);
  const receive = vi.fn();
  await expect(pending.consume(receive)).resolves.toBeUndefined();
  expect(writes).toBeGreaterThanOrEqual(3);
  expect(receive).toHaveBeenCalledTimes(1);
  expect(receive.mock.calls[0]?.[0]).toContain(canary);
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(receive).toHaveBeenCalledTimes(1);
}
it.each(['other', 'conversation'])(
  'delivers once during sustained unrelated activity in %s', sustainedUnrelatedActivity);

async function retryBeforeRelease() {
  await fact();
  const params = { conversationId: 'conversation', turnId: 'turn' };
  const selected = await turnMemoryPreview(options, 'alice', params);
  const pending = await prepare();
  await pending.load();
  let unavailable = true;
  function temporaryOutage() {
    if (unavailable) throw new Error('Temporary deployment read failure');
    return Promise.resolve();
  }
  deployment.observe(temporaryOutage);
  const receive = vi.fn();
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(receive).not.toHaveBeenCalled();
  unavailable = false;
  await fact('later', 'Do not select this on retry');
  await expect(pending.consume(receive)).resolves.toBeUndefined();
  expect(receive).toHaveBeenCalledExactlyOnceWith(selected.block);
  await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
  expect(receive).toHaveBeenCalledTimes(1);
}
it('retains the exact block for a checked retry before release begins', retryBeforeRelease);


async function lateStreamReadChange(kind: string) {
  await fact('fact', canary, new Date(Date.now() + 60_000).toISOString());
  const pending = await prepare();
  await pending.load();
  let observed = false;
  async function unrelated() {
    observed = true;
    await setup.append('conversation-other', 'agent.turn_started', {
      assistantId: 'other', conversationId: 'other', turnId: randomUUID() });
  }
  deployment.observe(unrelated);
  const head = options.store.head.bind(options.store);
  let releaseReads = 0;
  let readingTails = false;
  async function capture(...args: Parameters<typeof head>) {
    if (observed && args[0] === undefined) {
      releaseReads += 1;
    }
    const position = await head(...args);
    if (releaseReads === 2) {
      readingTails = true;
    }
    return position;
  }
  vi.spyOn(options.store, 'head').mockImplementation(capture);
  let subject = `scope-${scopeId}`;
  if (kind === 'removed') {
    subject = 'member-alice';
  } else if (kind === 'closed' || kind === 'unrelated') {
    subject = 'conversation-conversation';
  } else if (kind === 'replacement') {
    subject = 'computer-assistant';
  }
  const readStream = options.store.readStream.bind(options.store);
  let changed = false;
  async function* interrupt(...args: Parameters<typeof readStream>) {
    // Save the change after the global position read, before this stream returns its events.
    if (readingTails && !changed && args[0] === subject) {
      expect(args[1]).toBeGreaterThan(1);
      changed = true;
      await deploymentChange(kind);
    }
    yield* readStream(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(interrupt);
  const receive = vi.fn();
  if (kind === 'unrelated') {
    await expect(pending.consume(receive)).resolves.toBeUndefined();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toContain(canary);
    await expect(pending.consume(receive)).rejects.toThrow('memory_context_unavailable');
    expect(receive).toHaveBeenCalledTimes(1);
  } else {
    const refusal = kind === 'removed' ? MemberAccessRefused : 'memory_context_unavailable';
    await expect(pending.consume(receive)).rejects.toThrow(refusal);
    await expect(pending.consume(receive)).rejects.toThrow(refusal);
    expect(receive).not.toHaveBeenCalled();
  }
  expect(changed).toBe(true);
}
it.each(['removed', 'corrected', 'forgotten', 'closed', 'replacement',
  'withdrawn', 'expired', 'unrelated'])(
  'checks %s during the final relevant stream read', lateStreamReadChange);

const admitted = { conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
  requesterId: 'alice', model: 'gpt-6-luna', task: 'chat_turn' as const,
  executionMode: 'restricted' as const };
const bridgeContext = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
async function credentialMessage(text = 'New question') {
  const data = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', 'conversation', text) };
  const saved = await setup.append('conversation-conversation', 'message.posted', data);
  const message = { ...saved, id: 'turn', commandId: 'turn' };
  await setup.nats.seed([message]);
}
async function credentials(acknowledgement: Record<string, unknown>,
  executionMode: 'restricted' | 'memory_free' = 'restricted', replay = false) {
  const bridgeOptions = { ...options, keys: setup.keys };
  const turn = { ...admitted, executionMode };
  function release(reply: object) {
    Object.assign(acknowledgement, reply);
  }
  await releaseTurnCredentials(bridgeOptions, bridgeContext, setup.tokens, { ...admitted, replay },
    turn, acknowledgement, release);
}
async function initialCredentials(count: number) {
  if (count) await fact();
  await credentialMessage();
  const sign = setup.tokens.turn.bind(setup.tokens);
  async function signing(input: Parameters<typeof sign>[0]) {
    expect((await state())?.initialLoaded).toBe(true);
    return sign(input);
  }
  const signed = vi.spyOn(setup.tokens, 'turn').mockImplementation(signing);
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement);
  expect(acknowledgement).not.toHaveProperty('refused');
  expect(acknowledgement['token']).toBeTruthy();
  expect(acknowledgement['initialInput']).toContain('New question');
  expect(acknowledgement['initialInput']).toContain('Initial personal memory follows');
  if (count) expect(acknowledgement['initialInput']).toContain(canary);
  expect(acknowledgement).not.toHaveProperty('context');
  expect(setup.received()).toBe(0);
  const cold = await createEventStore(setup.nats.connection);
  options.store = cold;
  const repeated: Record<string, unknown> = {};
  await credentials(repeated);
  expect(repeated).toEqual({ refused: 'memory_context_unavailable' });
  expect(signed).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await history(cold, 'conversation-conversation', 'test')))
    .not.toContain(canary);
}
it.each([0, 1])('loads %i facts before signing and never resends on cold reconnect',
  initialCredentials);
async function changedWhileSigning(kind: string) {
  await fact();
  await credentialMessage();
  const sign = setup.tokens.turn.bind(setup.tokens);
  async function signing(input: Parameters<typeof sign>[0]) {
    const grant = await sign(input);
    await deploymentChange(kind);
    return grant;
  }
  vi.spyOn(setup.tokens, 'turn').mockImplementation(signing);
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement);
  expect(acknowledgement).toHaveProperty('refused');
  expect(acknowledgement).not.toHaveProperty('token');
  expect(acknowledgement).not.toHaveProperty('initialInput');
  expect(acknowledgement).not.toHaveProperty('context');
}
it.each(['corrected', 'forgotten', 'removed', 'replacement', 'withdrawn', 'closed'])(
  'releases neither input nor credentials after %s during signing', changedWhileSigning);
async function oversizedCredentials() {
  await fact();
  await credentialMessage('"'.repeat(65_000));
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement);
  expect(acknowledgement).toEqual({ refused: 'memory_context_unavailable' });
}
it('refuses the complete escaped credential frame above 120 KiB', oversizedCredentials);

async function memoryFreeCredentials() {
  await fact();
  await credentialMessage();
  deployment.remove();
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement, 'memory_free');
  expect(acknowledgement['token']).toBeTruthy();
  expect(acknowledgement).not.toHaveProperty('context');
  expect(acknowledgement).not.toHaveProperty('initialInput');
  expect(await state()).toBeUndefined();
}
it('gives explicit memory-free work no history or memory block', memoryFreeCredentials);
async function admitsCompleteInput() {
  await fact('fact', 'Remember these words. '.repeat(150));
  await credentialMessage();
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement);
  expect(acknowledgement).not.toHaveProperty('refused');
  const body = { model: admitted.model, input: acknowledgement['initialInput'],
    max_output_tokens: 2000, stream: true };
  const request = { method: 'POST', headers: setup.headers, body: JSON.stringify(body) };
  const response = await fetch(`${setup.options.decisionUrl}/authorize`, request);
  expect(response.status).toBe(200);
  const reservation = setup.actor.state.reservations[0]!;
  expect(reservation.amountCents).toBe(requestReservationCents(body));
  expect(Number.isSafeInteger(reservation.amountCents)).toBe(true);
  const rootBinding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'next',
    threadId: 'next-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
    payingGroupId: 'personal-default', allowanceCents: 1000 };
  const root = await setup.actor.setRootAllowance(rootBinding, reservation.amountCents);
  expect(Number.isSafeInteger(root.allowanceCents)).toBe(true);
  const nextCall = { ...reservation.call, turnId: 'next', threadId: 'next-thread' };
  await expect(setup.actor.reserve(nextCall, root.allowanceCents + 1,
    undefined, undefined, root.rootId)).rejects.toThrow('Root budget refused');
  expect(setup.received()).toBe(0);
}
it('counts the complete request and keeps integer-cent root ceilings without a selection call',
  admitsCompleteInput);
async function slowHistoryCredentials() {
  await fact();
  await credentialMessage();
  const read = options.store.readStream.bind(options.store);
  let delayed = false;
  async function* slowRead(...args: Parameters<typeof read>) {
    if (args[0] === 'conversation-conversation' && !delayed) {
      delayed = true;
      expect(args[2]! - performance.now()).toBeGreaterThan(2000);
      function wait(resolve: () => void) {
        setTimeout(resolve, 2100);
      }
      await new Promise<void>(wait);
    }
    yield* read(...args);
  }
  vi.spyOn(options.store, 'readStream').mockImplementation(slowRead);
  const sign = setup.tokens.turn.bind(setup.tokens);
  async function signing(input: Parameters<typeof sign>[0]) {
    const grant = await sign(input);
    const text = setup.keys.encrypt('test', 'conversation', 'Unrelated message');
    await setup.append('conversation-conversation', 'message.posted', {
      conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...text });
    await deploymentChange('unrelated');
    await setup.append('conversation-conversation', 'file.uploaded', {
      conversationId: 'conversation', fileId: 'unrelated', uploadedBy: 'alice', name: 'notes.txt',
      size: 5, sha256: 'a'.repeat(64), mime: 'text/plain', objectKey: 'test/conversation/unrelated' });
    return grant;
  }
  vi.spyOn(setup.tokens, 'turn').mockImplementation(signing);
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement);
  expect(delayed).toBe(true);
  expect(acknowledgement).not.toHaveProperty('refused');
  expect(acknowledgement['initialInput']).toContain(canary);
}
it('reads slow history before access checks and permits unrelated activity while signing',
  slowHistoryCredentials);

async function refusesUncertainStart() {
  await credentialMessage();
  const acknowledgement: Record<string, unknown> = {};
  await credentials(acknowledgement, 'restricted', true);
  expect(acknowledgement).toEqual({ refused: 'memory_context_unavailable' });
  expect(await state()).toBeUndefined();
}
it('never upgrades a replayed private start even before initial evidence exists',
  refusesUncertainStart);

async function refusesLaterStartAfterQualificationLoss() {
  const message = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', 'conversation', 'Numbered question') };
  const saved = await setup.append('conversation-conversation', 'message.posted', message);
  const report = { conversationId: 'conversation', turnId: saved.id, threadId: 'numbered-thread',
    assistantId: 'assistant', sequence: 1, previousSequence: 0,
    type: 'agent.turn_started', executionMode: 'restricted' as const };
  await recordReport(options.store, setup.keys, bridgeContext, report);
  const input = { ...report, status: 'started' as const };
  const turn = await turnCommand(options.store, bridgeContext, input);
  expect(turn?.executionMode).toBe('restricted');
  if (!turn) throw new Error('Missing admitted fixture turn');
  deployment.remove();
  const signed = vi.spyOn(setup.tokens, 'turn');
  const delivered = vi.fn();
  const bridgeOptions = { ...options, keys: setup.keys };
  for (const sequence of [1, 2]) {
    const retry = { ...report, sequence, previousSequence: sequence - 1 };
    if (sequence > 1) await recordReport(options.store, setup.keys, bridgeContext, retry);
    const acknowledgement: Record<string, unknown> = {};
    await releaseTurnCredentials(bridgeOptions, bridgeContext, setup.tokens, retry,
      turn, acknowledgement, delivered);
    expect(acknowledgement).toEqual({ refused: 'memory_context_unavailable' });
    const facts = await readChatFacts(options.store, 'test', 'conversation', saved.id);
    expect(facts.memoryContext).toBeUndefined();
  }
  expect(signed).not.toHaveBeenCalled();
  expect(delivered).not.toHaveBeenCalled();
}
it('refuses a later numbered start after qualification disappears before preparation',
  refusesLaterStartAfterQualificationLoss);
