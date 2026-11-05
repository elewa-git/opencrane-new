import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as processes from 'node:child_process';
import type { TurnSummary } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, MemberAccessRefused, privateCallers, readToolPolicy }
  from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { memoryJourney } from '../../../scripts/private-memory-qualification/memory-journey.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { catalogueEvidence, toolEvidence } from '@opencrane/models/testing';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { privateToolOffer } from './support/private-catalogue.ts';
import { initialQualificationFixture } from './support/initial-qualification.ts';
import { preparePersonalMemoryTools, preparePersonalRecallLoad }
  from '../src/chat/personal-memory-tools.ts';
import { checkPrivateTurnTools, type TurnToolServerState } from '../src/chat/turn-tools.ts';
import { correctTool, forgetTool, recallTool, rememberTool } from '../src/memory/mcp.ts';

async function cryptoModule() {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, createDecipheriv: vi.fn(actual.createDecipheriv) };
}
async function processModule() {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual };
}
async function filesystemModule() {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual };
}
vi.mock('node:fs', filesystemModule);
vi.mock('node:crypto', cryptoModule);
vi.mock('node:child_process', processModule);

let fga: Awaited<ReturnType<typeof openfga>>;
async function startServices() { fga = await openfga(); }
async function stopServices() { await fga?.close(); }
beforeAll(startServices, 120_000);
afterAll(stopServices);
afterEach(vi.restoreAllMocks);

const operations = ['recall', 'remember', 'correct', 'forget'] as const;
const definitions = { recall: recallTool, remember: rememberTool,
  correct: correctTool, forget: forgetTool };
const grantSubject = grantStream('mcp_server', 'memory');
function rejectSql(): never { throw new Error('Unexpected SQL'); }
const noSql = { query: rejectSql };
function dropped() { /* No proxy runs in this preparation fixture. */ }

type Operation = typeof operations[number] | 'all';

async function fixture(operation: Operation = 'recall', role = 'owner', deploymentReads = false) {
  const nats = await natsFixture();
  onTestFinished(nats.close);
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  async function save(subject: string, type: string, data: unknown, apply = true) {
    const event = envelope('test', subject, type, data);
    if (type === 'mcp.server_reviewed') event.principal = { kind: 'human', id: 'alice' };
    await nats.seed([event]);
    if (apply) await auth.handler.handle(event, noSql);
    return event;
  }
  await save('member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role,
  });
  await save('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
  });
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
    await save(grantSubject, 'grant.given', {
      resourceType: 'mcp_server', resourceId: 'memory', granteeKind, granteeId,
      grantedBy: 'alice',
    });
  }
  const callers = privateCallers(dropped);
  onTestFinished(callers.close);
  const grant = { silo: 'test', requesterId: 'alice', assistantId: 'assistant',
    computerId: 'computer', conversation: 'conversation', turnId: 'turn', thread: 'thread',
    generation: 1, inputGeneration: 1, expires: Date.now() + 60_000 };
  const registration = callers.register(grant);
  registration.bind(grant.thread);
  const data = { conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    task: 'chat_turn', executionMode: 'restricted' };
  const event = envelope('test', 'computer-assistant', 'computer.turn_started', data);
  event.source = 'opencrane-server';
  await nats.seed([event]);
  const sequence = await nats.store.head('computer-assistant');
  const turn: TurnSummary = { hasStart: true, firstStart: { event, sequence },
    firstClose: undefined };
  const selected = operation === 'all' ? operations : [operation];
  const state: TurnToolServerState = {
    serverId: 'memory', connectionId: 'server', published: true, accountMode: 'none',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    discoveryTools: [], policyTools: [],
  };
  for (const name of selected) {
    const definition = JSON.stringify(definitions[name]);
    const revision = losslessJson(definition).digest;
    state.discoveryTools.push({ name, definition, revision });
    state.policyTools.push({ name, revision, reviewed: true, costCents: 0, mode: 'allow' });
  }
  function readServer() { return Promise.resolve(state); }
  const runtime = { sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    environmentId: 'disposable-test-host' };
  const qualification = { ...runtime, result: 'PASS', checks: {
    privateTurns: 'PASS', nativeRecall: 'PASS', requesterIsolation: 'PASS',
    sessionIsolation: 'PASS', invalidation: 'PASS', unrelatedActivity: 'PASS',
    stopReconnect: 'PASS', replacementReload: 'PASS', persistence: 'PASS',
  } };
  const input = { silo: 'test', store: nats.store, binding, operation,
    requesterId: 'alice', assistantId: 'assistant',
    scopeId: memoryScopeId('test', 'person', 'alice'), baseMessageBytes: 100,
    turn, grant, caller: registration.caller, callers, runtime, qualification,
    readServer: vi.fn(readServer) };
  const realCheck = auth.check.bind(auth);
  const realUse = auth.use.bind(auth);
  const check = vi.spyOn(auth, 'check');
  const use = vi.spyOn(auth, 'use');
  const append = vi.spyOn(nats.store, 'append');
  vi.mocked(crypto.createDecipheriv).mockClear();
  const spawned = vi.spyOn(processes, 'spawn');
  spawned.mockClear();
  function noEffects() {
    expect(append).not.toHaveBeenCalled();
    expect(crypto.createDecipheriv).not.toHaveBeenCalled();
    if (!deploymentReads) expect(spawned).not.toHaveBeenCalled();
  }
  onTestFinished(noEffects);
  return { input, auth, check, use, realCheck, realUse, save, registration, state, append };
}

async function preparesOwner(operation: typeof operations[number]) {
  const { input, check, use } = await fixture(operation);
  const tools = await preparePersonalMemoryTools(input);
  expect(tools).toHaveLength(1);
  expect(tools[0]?.definitions).toEqual([JSON.stringify(definitions[operation])]);
  expect(checkPrivateTurnTools(tools, input)).toBe(true);
  expect(checkPrivateTurnTools([...tools], input)).toBe(false);
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(use.mock.calls).toEqual([
    ['person', 'alice', 'mcp_server', 'memory'],
    ['assistant', 'assistant', 'mcp_server', 'memory'],
  ]);
}
it.each(operations)('prepares the owner’s original approved %s list without effects', preparesOwner);

async function removal(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.save('member-alice', 'member.removed',
    { memberId: 'alice', removedBy: 'owner' }, false);
}
async function refusesBeforeFailure(service: 'catalogue' | 'permission',
  operation: Operation = 'recall') {
  const setup = await fixture(operation);
  await removal(setup);
  expect((await setup.auth.check('alice', 'member')).allowed).toBe(true);
  setup.check.mockClear();
  const failure = new Error('private-upstream-canary');
  if (service === 'catalogue') setup.input.readServer.mockRejectedValue(failure);
  if (service === 'permission') setup.check.mockRejectedValue(failure);
  await expect(preparePersonalMemoryTools(setup.input)).rejects.toThrow(MemberAccessRefused);
  expect(setup.input.readServer).not.toHaveBeenCalled();
  expect(setup.check).not.toHaveBeenCalled();
  expect(setup.use).not.toHaveBeenCalled();
}
async function singleFailureBefore(service: 'catalogue' | 'permission') {
  await refusesBeforeFailure(service);
}
it.each(['catalogue', 'permission'] as const)(
  'preserves saved removal before the unavailable %s is called', singleFailureBefore);

async function refusesMissingReceipt(subject: 'membership' | 'grant') {
  const setup = await fixture();
  let event;
  if (subject === 'membership') {
    event = await setup.save('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'owner',
    }, false);
  } else {
    event = await setup.save(grantSubject, 'grant.revoked', {
      resourceType: 'mcp_server', resourceId: 'memory', granteeId: 'alice',
      granteeKind: 'member', revokedBy: 'owner',
    }, false);
  }
  expect((await setup.auth.use('person', 'alice', 'mcp_server', 'memory')).allowed).toBe(true);
  setup.use.mockClear();
  expect(await preparePersonalMemoryTools(setup.input)).toEqual([]);
  await setup.auth.handler.handle(event, noSql);
  const tools = await preparePersonalMemoryTools(setup.input);
  expect(tools).toHaveLength(subject === 'membership' ? 1 : 0);
}
it.each(['membership', 'grant'] as const)('refuses an unapplied %s receipt', refusesMissingReceipt);

async function refusesOutage() {
  const { input } = await fixture();
  input.binding = { ...input.binding, apiUrl: 'http://127.0.0.1:1' };
  expect(await preparePersonalMemoryTools(input)).toEqual([]);
}
it('offers no tools when only IAM is unavailable', refusesOutage);

async function refusesLateReceipt() {
  const { input, auth, check, use } = await fixture();
  const applied = auth.applied.bind(auth);
  const now = performance.now();
  const clock = vi.spyOn(performance, 'now');
  // Freeze the start too so service scheduling cannot move the expected expiry.
  clock.mockReturnValue(now);
  async function late(eventId: string) {
    const result = await applied(eventId);
    clock.mockReturnValue(now + 10_001);
    return result;
  }
  vi.spyOn(auth, 'applied').mockImplementationOnce(late);
  expect(await preparePersonalMemoryTools(input)).toEqual([]);
  expect(check.mock.calls.length).toBeLessThanOrEqual(1);
  expect(use.mock.calls.length).toBeLessThanOrEqual(2);
  clock.mockRestore();
}
it('does not renew the read deadline for a late applied receipt', refusesLateReceipt);

async function adminScope() {
  const setup = await fixture('correct', 'admin');
  setup.input.scopeId = memoryScopeId('test', 'person', 'bob');
  expect(await preparePersonalMemoryTools(setup.input)).toEqual([]);
  setup.input.scopeId = memoryScopeId('test', 'person', 'alice');
  await setup.save('member-alice', 'member.role_changed', {
    memberId: 'alice', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
  });
  expect(await preparePersonalMemoryTools(setup.input)).toHaveLength(1);
  await setup.save(grantSubject, 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: 'memory', granteeKind: 'assistant',
    granteeId: 'assistant', revokedBy: 'owner',
  });
  expect(await preparePersonalMemoryTools(setup.input)).toEqual([]);
}
it('limits admins to their own scope and keeps only granted rights after demotion', adminScope);

const changes = ['removal', 'demotion', 'grant', 'activity', 'caller', 'generation', 'qualification', 'deadline'] as const;
async function changesDuringRead(change: typeof changes[number], stage: 'catalogue' | 'permission',
  operation: Operation = 'recall') {
  const setup = await fixture(operation);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function readServer() {
    started.resolve();
    await resume.promise;
    return setup.state;
  }
  const use = setup.realUse;
  async function delayedUse(...args: Parameters<typeof use>) {
    const permission = await use(...args);
    started.resolve();
    await resume.promise;
    return permission;
  }
  if (stage === 'catalogue') setup.input.readServer.mockImplementation(readServer);
  if (stage === 'permission') setup.use.mockImplementationOnce(delayedUse);
  const preparing = preparePersonalMemoryTools(setup.input);
  const result = Promise.allSettled([preparing]);
  await started.promise;
  if (change === 'removal') await removal(setup);
  if (change === 'demotion') {
    await setup.save('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'owner',
    });
  }
  if (change === 'grant') {
    await setup.save(grantSubject, 'grant.revoked', {
      resourceType: 'mcp_server', resourceId: 'memory', granteeKind: 'assistant',
      granteeId: 'assistant', revokedBy: 'owner',
    }, false);
  }
  if (change === 'activity') {
    await setup.save('conversation-conversation', 'agent.turn_started', {
      conversationId: 'conversation', assistantId: 'assistant', turnId: 'another',
    }, false);
    await setup.save('conversation-conversation', 'file.uploaded', {
      conversationId: 'conversation', fileId: 'file', uploadedBy: 'alice', name: 'safe.txt',
      size: 1, sha256: 'a'.repeat(64), mime: 'text/plain', objectKey: 'test/conversation/file',
    }, false);
  }
  if (change === 'caller') setup.registration.close();
  if (change === 'generation') setup.input.grant.inputGeneration += 1;
  if (change === 'qualification') setup.input.qualification = {
    ...setup.input.qualification, result: 'FAIL',
  };
  if (change === 'deadline') {
    const late = performance.now() + 10_001;
    vi.spyOn(performance, 'now').mockReturnValue(late);
  }
  resume.resolve();
  const [outcome] = await result;
  if (change === 'removal') {
    expect(outcome?.status).toBe('rejected');
    if (outcome?.status === 'rejected') expect(outcome.reason).toBeInstanceOf(MemberAccessRefused);
  } else {
    expect(outcome?.status).toBe('fulfilled');
    if (outcome?.status === 'fulfilled') {
      expect(outcome.value).toHaveLength(change === 'activity' ? 1 : 0);
      if (change === 'activity') {
        expect(checkPrivateTurnTools(outcome.value, setup.input)).toBe(true);
        if (operation === 'all') expect(outcome.value).toEqual(privateToolOffer('all'));
      }
    }
  }
  expect(setup.check).toHaveBeenCalledTimes(1);
  expect(setup.use).toHaveBeenCalledTimes(2);
}
for (const stage of ['catalogue', 'permission'] as const) {
  async function checksChange(change: typeof changes[number]) {
    await changesDuringRead(change, stage);
  }
  it.each(changes)(`confirms %s after a delayed ${stage} read`, checksChange);
}

async function removalDuringFailure(service: 'catalogue' | 'permission',
  operation: Operation = 'recall') {
  const setup = await fixture(operation);
  async function failsAfterRemoval(): Promise<never> {
    await removal(setup);
    throw new Error('private-upstream-canary');
  }
  if (service === 'catalogue') setup.input.readServer.mockImplementation(failsAfterRemoval);
  if (service === 'permission') setup.use.mockImplementationOnce(failsAfterRemoval);
  await expect(preparePersonalMemoryTools(setup.input)).rejects.toThrow(MemberAccessRefused);
  expect(setup.check).toHaveBeenCalledTimes(1);
  expect(setup.use.mock.calls.length).toBeLessThanOrEqual(2);
}
async function singleFailureDuring(service: 'catalogue' | 'permission') {
  await removalDuringFailure(service);
}
it.each(['catalogue', 'permission'] as const)(
  'preserves removal saved during a failing %s read without another decision', singleFailureDuring);

async function preservesConfirmedRefusal() {
  const setup = await fixture();
  const check = setup.realCheck;
  const failure = new Error('private-upstream-canary');
  function unavailableHistory(): never { throw failure; }
  async function deny(...args: Parameters<typeof check>) {
    await setup.save('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'owner',
    });
    const permission = await check(...args);
    vi.spyOn(setup.input.store, 'readStream').mockImplementation(unavailableHistory);
    return permission;
  }
  setup.check.mockImplementationOnce(deny);
  await expect(preparePersonalMemoryTools(setup.input)).rejects.toThrow(MemberAccessRefused);
  expect(setup.check).toHaveBeenCalledTimes(1);
  expect(setup.input.readServer).not.toHaveBeenCalled();
}
it('keeps a confirmed membership refusal when further history reads would fail',
  preservesConfirmedRefusal);

async function checksTeamReceipts() {
  const setup = await fixture();
  await setup.save('team-group', 'team.created', {
    teamId: 'group', name: 'Group', createdBy: 'alice',
  });
  await setup.save('team-group', 'team.member_added', {
    teamId: 'group', memberId: 'alice', addedBy: 'alice',
  });
  await setup.save(grantSubject, 'grant.given', {
    resourceType: 'mcp_server', resourceId: 'memory', granteeKind: 'team',
    granteeId: 'group', grantedBy: 'alice',
  });
  await setup.save(grantSubject, 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: 'memory', granteeKind: 'member',
    granteeId: 'alice', revokedBy: 'alice',
  });
  expect(await preparePersonalMemoryTools(setup.input)).toHaveLength(1);
  await setup.save('team-group', 'team.member_removed', {
    teamId: 'group', memberId: 'alice', removedBy: 'alice',
  }, false);
  expect(await preparePersonalMemoryTools(setup.input)).toEqual([]);
}
it('requires applied team membership when a team supplies the personal tool grant',
  checksTeamReceipts);

async function changesDuringConfirmation(change: 'caller' | 'generation' | 'qualification' | 'turn') {
  const setup = await fixture();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readHead = setup.input.store.head.bind(setup.input.store);
  let catalogueRead = false;
  function readServer() {
    catalogueRead = true;
    return Promise.resolve(setup.state);
  }
  async function delayedHead(...args: Parameters<typeof readHead>) {
    const position = await readHead(...args);
    if (catalogueRead) {
      catalogueRead = false;
      started.resolve();
      await resume.promise;
    }
    return position;
  }
  setup.input.readServer.mockImplementation(readServer);
  vi.spyOn(setup.input.store, 'head').mockImplementation(delayedHead);
  const preparing = preparePersonalMemoryTools(setup.input);
  await started.promise;
  if (change === 'caller') setup.registration.close();
  if (change === 'generation') setup.input.grant.inputGeneration += 1;
  if (change === 'qualification') setup.input.qualification.checks.persistence = 'FAIL';
  if (change === 'turn') {
    setup.input.turn.firstClose = { sequence: 100, status: 'completed' };
  }
  resume.resolve();
  expect(await preparing).toEqual([]);
  expect(setup.check).toHaveBeenCalledTimes(1);
  expect(setup.use).toHaveBeenCalledTimes(2);
}
it.each(['caller', 'generation', 'qualification', 'turn'] as const)(
  'rejects changed %s during final access confirmation', changesDuringConfirmation);

async function preparesCombined() {
  const { input, check, use } = await fixture('all');
  const tools = await preparePersonalMemoryTools(input);
  expect(tools).toEqual(privateToolOffer('all'));
  expect(checkPrivateTurnTools(tools, input)).toBe(true);
  expect(checkPrivateTurnTools([...tools], input)).toBe(false);
  expect(check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(use.mock.calls).toEqual([
    ['person', 'alice', 'mcp_server', 'memory'],
    ['assistant', 'assistant', 'mcp_server', 'memory'],
  ]);
  expect(input.readServer).toHaveBeenCalledExactlyOnceWith('memory');
}
it('prepares all four approved tools with one membership decision', preparesCombined);

async function refusesCombinedRemoval() {
  const setup = await fixture('all');
  await removal(setup);
  expect((await setup.realCheck('alice', 'member')).allowed).toBe(true);
  expect((await setup.realUse('person', 'alice', 'mcp_server', 'memory')).allowed).toBe(true);
  expect((await setup.realUse('assistant', 'assistant', 'mcp_server', 'memory')).allowed).toBe(true);
  expect(setup.input.callers.check(setup.input.grant)).toBe(true);
  await expect(preparePersonalMemoryTools(setup.input)).rejects.toThrow(MemberAccessRefused);
  expect(setup.check).not.toHaveBeenCalled();
  expect(setup.use).not.toHaveBeenCalled();
  expect(setup.input.readServer).not.toHaveBeenCalled();
}
it('refuses combined preparation after removal despite a live turn and stale grants',
  refusesCombinedRemoval);

async function combinedFailureBefore(service: 'catalogue' | 'permission') {
  await refusesBeforeFailure(service, 'all');
}
async function combinedFailureDuring(service: 'catalogue' | 'permission') {
  await removalDuringFailure(service, 'all');
}
it.each(['catalogue', 'permission'] as const)(
  'preserves combined removal before %s failure', combinedFailureBefore);
it.each(['catalogue', 'permission'] as const)(
  'preserves combined removal during %s failure', combinedFailureDuring);

for (const stage of ['catalogue', 'permission'] as const) {
  async function combinedChange(change: typeof changes[number]) {
    await changesDuringRead(change, stage, 'all');
  }
  it.each(changes)(`confirms combined %s after a delayed ${stage} read`, combinedChange);
}

async function refusesCombinedPermission(kind: 'person' | 'assistant') {
  const setup = await fixture('all');
  const granteeKind = kind === 'person' ? 'member' : 'assistant';
  const granteeId = kind === 'person' ? 'alice' : 'assistant';
  await setup.save(grantSubject, 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: 'memory', granteeKind, granteeId,
    revokedBy: 'owner',
  });
  expect((await setup.realUse(kind, granteeId, 'mcp_server', 'memory')).allowed).toBe(false);
  expect(await preparePersonalMemoryTools(setup.input)).toEqual([]);
  expect(setup.check).toHaveBeenCalledExactlyOnceWith('alice', 'member');
  expect(setup.use).toHaveBeenCalledTimes(kind === 'person' ? 1 : 2);
  expect(setup.input.readServer).not.toHaveBeenCalled();
}
it.each(['person', 'assistant'] as const)(
  'refuses all four tools when the %s permission callback denies access', refusesCombinedPermission);

function rememberOffer() {
  const tools = privateToolOffer('recall');
  tools[0]!.definitions.push(...privateToolOffer('remember')[0]!.definitions);
  tools[0]!.modes['remember'] = 'allow';
  return tools;
}

async function recallLoadFixture() {
  const setup = await fixture('recall', 'owner', true);
  const readyComputer = {
    assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'fixture',
  };
  await setup.save('computer-assistant', 'computer.ready', readyComputer, false);
  const createdConversation = {
    conversationId: 'conversation', mode: 'agent_session', assistantId: 'assistant',
    createdBy: 'alice',
  };
  await setup.save('conversation-conversation', 'conversation.created', createdConversation, false);
  function evidence(definition: typeof recallTool | typeof rememberTool) {
    const encoded = JSON.stringify(definition);
    const declared = { name: definition.name, reviewed: true, costCents: 0 };
    return { ...toolEvidence(declared), definition: encoded, revision: losslessJson(encoded).digest };
  }
  const tools = [evidence(recallTool), evidence(rememberTool)];
  const catalogue = catalogueEvidence(tools);
  const registeredServer = { serverId: 'memory',
    kind: 'hosted', registeredBy: 'alice', locator: `registry.example.test/memory@sha256:${'a'.repeat(64)}` };
  await setup.save('mcp-memory', 'mcp.server_registered', registeredServer, false);
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(checkedAt) + 300_000).toISOString();
  const discoveredServer = { serverId: 'memory',
    connectionId: 'server', accountMode: 'none', checkedAt, expiresAt,
    serverInfo: { name: 'OpenCrane memory', version: '1' }, ...catalogue };
  await setup.save('mcp-memory', 'mcp.server_discovered', discoveredServer, false);
  const policy = await readToolPolicy(setup.input.store, 'test', 'memory');
  function choice(tool: typeof tools[number]) {
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode: 'allow' };
  }
  const choices = tools.map(choice);
  const reviewedServer = { serverId: 'memory',
    catalogueDigest: catalogue.schemaDigest, connectionId: 'server', accountMode: 'none',
    policyRevision: policy.policyRevision, reviewedBy: 'alice', tools: choices };
  await setup.save('mcp-memory', 'mcp.server_reviewed', reviewedServer, false);
  const publishedServer = {
    serverId: 'memory', publishedBy: 'alice',
  };
  await setup.save('mcp-memory', 'mcp.server_published', publishedServer, false);
  setup.append.mockClear();
  const deployment = await initialQualificationFixture();
  const pending = { type: 'recall_pending', loadId: '11111111-1111-4111-8111-111111111111',
    silo: 'test', requesterId: 'alice', assistantId: 'assistant', computerId: 'computer',
    conversationId: 'conversation', turnId: 'turn', threadId: 'thread', generation: 1,
    inputGeneration: 1, expiresAt: setup.input.grant.expires };
  return { ...setup, deployment, pending };
}

async function preparesSavedRecall() {
  const setup = await recallLoadFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const expected = { ...setup.pending, type: 'recall_load', tools: rememberOffer() };
  expect(load.request).toEqual(expected);
  expect(JSON.stringify(load.request)).not.toContain(setup.input.caller);
  expect(JSON.stringify(load.request)).not.toContain('qualification');
  const reply = { ...setup.pending, type: 'recall_loaded' };
  const tools = await load.complete(reply);
  expect(tools).toEqual(rememberOffer());
  expect(checkPrivateTurnTools(tools, setup.input)).toBe(true);
  await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
}
it('prepares saved recall and accepts one exact discovery receipt without wire approval',
  preparesSavedRecall);

const changedReceipts = [
  { loadId: '22222222-2222-4222-8222-222222222222' }, { threadId: 'other' },
  { requesterId: 'bob' }, { conversationId: 'other' }, { turnId: 'other' },
  { assistantId: 'other' }, { computerId: 'other' }, { silo: 'other' },
  { generation: 2 }, { inputGeneration: 2 }, { expiresAt: 1 }, { extra: true },
  { type: 'recall_pending' },
];
async function refusesDiscoveryReceipt(change: object) {
  const setup = await recallLoadFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const reply = { ...setup.pending, type: 'recall_loaded', ...change };
  await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
  const correct = { ...setup.pending, type: 'recall_loaded' };
  await expect(load.complete(correct)).rejects.toThrow('memory_context_unavailable');
}
it.each(changedReceipts)('consumes a refused discovery receipt without retry: %j',
  refusesDiscoveryReceipt);

const discoveryChanges = ['removal', 'demotion', 'grant', 'policy', 'qualification',
  'replacement', 'closure', 'Stop', 'caller', 'activity'] as const;
async function rechecksAfterDiscovery(change: typeof discoveryChanges[number]) {
  const setup = await recallLoadFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  if (change === 'removal') await removal(setup);
  if (change === 'demotion') {
    const demotedMember = {
      memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'owner',
    };
    await setup.save('member-alice', 'member.role_changed', demotedMember);
  }
  if (change === 'grant') {
    const revokedGrant = { resourceType: 'mcp_server', resourceId: 'memory',
      granteeKind: 'assistant', granteeId: 'assistant', revokedBy: 'owner' };
    await setup.save(grantSubject, 'grant.revoked', revokedGrant, false);
  }
  if (change === 'policy') {
    const unpublishedServer = {
      serverId: 'memory', unpublishedBy: 'alice',
    };
    await setup.save('mcp-memory', 'mcp.server_unpublished', unpublishedServer, false);
  }
  if (change === 'qualification') setup.deployment.remove();
  if (change === 'caller') setup.registration.close();
  if (change === 'replacement') {
    const replacedComputer = {
      assistantId: 'assistant', computerId: 'computer', generation: 2, podUid: 'replacement',
    };
    await setup.save('computer-assistant', 'computer.ready', replacedComputer, false);
  }
  if (change === 'closure') {
    const closedConversation = {
      conversationId: 'conversation', closedBy: 'alice',
    };
    await setup.save('conversation-conversation', 'conversation.closed', closedConversation, false);
  }
  if (change === 'Stop') {
    const stoppedTurn = {
      conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice',
    };
    await setup.save('conversation-conversation', 'agent.turn_stop_requested', stoppedTurn, false);
  }
  if (change === 'activity') {
    const neighbourTurn = {
      conversationId: 'conversation', turnId: 'neighbour', assistantId: 'assistant',
    };
    await setup.save('conversation-conversation', 'agent.turn_started', neighbourTurn, false);
    const uploadedFile = {
      conversationId: 'conversation', fileId: 'file', uploadedBy: 'alice', name: 'safe.txt',
      size: 1, sha256: 'a'.repeat(64), mime: 'text/plain', objectKey: 'fixture',
    };
    await setup.save('conversation-conversation', 'file.uploaded', uploadedFile, false);
  }
  const reply = { ...setup.pending, type: 'recall_loaded' };
  if (change === 'activity') {
    expect(await load.complete(reply)).toEqual(rememberOffer());
  } else if (change === 'removal') {
    setup.deployment.remove();
    await expect(load.complete(reply)).rejects.toThrow(MemberAccessRefused);
  } else {
    await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
  }
}
it.each(discoveryChanges)('rechecks saved access and identity after discovery: %s',
  rechecksAfterDiscovery);

async function refusesInitialReceipt(change: object) {
  const setup = await recallLoadFixture();
  const pending = { ...setup.pending, ...change };
  await expect(preparePersonalRecallLoad(setup.input, pending))
    .rejects.toThrow('memory_context_unavailable');
  expect(setup.check).not.toHaveBeenCalled();
}
const changedPendingReceipts = changedReceipts.slice(1, -1);
it.each(changedPendingReceipts)('refuses changed pending identity before discovery: %j',
  refusesInitialReceipt);

async function ignoresClaimedPreparation() {
  const setup = await recallLoadFixture();
  setup.input.turn.firstClose = { sequence: 999, status: 'failed' };
  setup.input.qualification.result = 'FAIL';
  setup.state.policyTools[0]!.mode = 'block';
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const reply = { ...setup.pending, type: 'recall_loaded' };
  expect(await load.complete(reply)).toEqual(rememberOffer());
  expect(setup.input.readServer).not.toHaveBeenCalled();
}
it('reads saved admission, policy and deployment instead of supplied preparation objects',
  ignoresClaimedPreparation);

async function refusesLateDiscovery() {
  const setup = await recallLoadFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const late = performance.now() + 10_001;
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValue(late);
  const reply = { ...setup.pending, type: 'recall_loaded' };
  await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
}
it('does not extend the preparation deadline while discovery is missing', refusesLateDiscovery);

async function loadedRecallFixture() {
  const setup = await recallLoadFixture();
  const journey = memoryJourney(setup.input.store, 'test', 'conversation');
  const fact = { ...journey.memoryWrittenExample, scopeId: journey.scopeId, memoryId: 'fact' };
  await journey.append(`scope-${journey.scopeId}`, 'memory.written', fact);
  await journey.append('conversation-conversation', 'agent.memory_context_recorded', journey.prepared);
  await journey.load();
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'memory_read', resourceId: journey.scopeId,
      granteeKind, granteeId, grantedBy: 'alice' };
    await setup.save(grantStream('memory_read', journey.scopeId), 'grant.given', grant);
  }
  const conversations = setup.input.store.readStream('conversation-conversation');
  for await (const row of conversations) {
    if (row.event.type === 'conversation.created') {
      await setup.auth.handler.handle(row.event, noSql);
    }
  }
  setup.append.mockClear();
  return { ...setup, journey };
}

async function invalidateRecall(setup: Awaited<ReturnType<typeof loadedRecallFixture>>,
  kind: 'corrected' | 'forgotten') {
  expect(setup.append).not.toHaveBeenCalled();
  await setup.journey.change(kind);
  expect(await setup.journey.invalidate()).toMatchObject({ status: 'invalidated' });
  setup.append.mockClear();
  const chat = await readChatFacts(setup.input.store, 'test', 'conversation', 'turn');
  expect(chat.memoryContext).toMatchObject({ status: 'invalidated',
    references: [setup.journey.reference] });
  expect(chat.turnEnded).toBe(false);
  expect(setup.input.callers.check(setup.input.grant)).toBe(true);
  // Leave the Stop reaction pending so only the saved invalidation can refuse recall.
  const rows = setup.input.store.readStream('conversation-conversation');
  for await (const row of rows) {
    expect(row.event.type).not.toBe('agent.turn_stop_requested');
  }
}

for (const stage of ['before preparation', 'before completion', 'during completion'] as const) {
  async function refusesInvalidatedRecall(kind: 'corrected' | 'forgotten') {
    const setup = await loadedRecallFixture();
    if (stage === 'before preparation') {
      await invalidateRecall(setup, kind);
      await expect(preparePersonalRecallLoad(setup.input, setup.pending))
        .rejects.toThrow('memory_context_unavailable');
      return;
    }
    const load = await preparePersonalRecallLoad(setup.input, setup.pending);
    const reply = { ...setup.pending, type: 'recall_loaded' };
    if (stage === 'before completion') {
      await invalidateRecall(setup, kind);
      await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
    } else {
      const waiting = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      async function delayedPermission(...args: Parameters<typeof setup.realCheck>) {
        waiting.resolve();
        await resume.promise;
        return setup.realCheck(...args);
      }
      setup.check.mockImplementationOnce(delayedPermission);
      const completion = load.complete(reply);
      const refused = expect(completion).rejects.toThrow('memory_context_unavailable');
      await waiting.promise;
      await invalidateRecall(setup, kind);
      resume.resolve();
      await refused;
    }
    await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
  }
  it.each(['corrected', 'forgotten'] as const)(
    `refuses recall when loaded memory is %s ${stage} with Stop delayed`, refusesInvalidatedRecall);
}

async function refusesEndedMemoryContext() {
  const setup = await loadedRecallFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  expect(setup.append).not.toHaveBeenCalled();
  const ended = { ...setup.journey.prepared, action: 'ended', reason: 'ended' };
  await setup.journey.append('conversation-conversation', 'agent.memory_context_recorded', ended);
  setup.append.mockClear();
  const reply = { ...setup.pending, type: 'recall_loaded' };
  await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
}
it('refuses discovery completion after saved memory ended without a turn-end event',
  refusesEndedMemoryContext);

async function refusesLatePreparationCancellation(stage: 'access' | 'activity') {
  const setup = await recallLoadFixture();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readHead = setup.input.store.head.bind(setup.input.store);
  let historyDeadline: number | undefined;
  let conversationReads = 0;
  let delayed = false;
  async function delayedHead(...args: Parameters<typeof readHead>) {
    const position = await readHead(...args);
    if (args[0] === undefined && historyDeadline === undefined) {
      historyDeadline = args[1];
    }
    if (args[0] === 'conversation-conversation') {
      conversationReads += 1;
    }
    const finalAccess = stage === 'access' && conversationReads === 2
      && args[0] === 'mcp-memory' && args[1] === historyDeadline;
    const finalActivity = stage === 'activity' && conversationReads === 3
      && args[0] === 'conversation-conversation';
    if (!delayed && (finalAccess || finalActivity)) {
      delayed = true;
      waiting.resolve();
      await resume.promise;
    }
    return position;
  }
  vi.spyOn(setup.input.store, 'head').mockImplementation(delayedHead);
  const preparation = preparePersonalRecallLoad(setup.input, setup.pending);
  const refused = expect(preparation).rejects.toThrow('memory_context_unavailable');
  await waiting.promise;
  setup.registration.close();
  resume.resolve();
  await refused;
}
it.each(['access', 'activity'] as const)(
  'refuses recall preparation when its caller closes during final %s confirmation',
  refusesLatePreparationCancellation);

for (const stage of ['before completion', 'during completion'] as const) {
  async function refusesChangedReference(kind: 'corrected' | 'forgotten') {
    const setup = await loadedRecallFixture();
    const load = await preparePersonalRecallLoad(setup.input, setup.pending);
    const reply = { ...setup.pending, type: 'recall_loaded' };
    async function changeReference() {
      expect(setup.append).not.toHaveBeenCalled();
      await setup.journey.change(kind);
      setup.append.mockClear();
      const chat = await readChatFacts(setup.input.store, 'test', 'conversation', 'turn');
      expect(chat.memoryContext?.status).toBe('loaded');
    }
    if (stage === 'before completion') {
      await changeReference();
      await expect(load.complete(reply)).rejects.toThrow('memory_context_unavailable');
      return;
    }
    const waiting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    async function delayedPermission(...args: Parameters<typeof setup.realCheck>) {
      waiting.resolve();
      await resume.promise;
      return setup.realCheck(...args);
    }
    setup.check.mockImplementationOnce(delayedPermission);
    const completion = load.complete(reply);
    const refused = expect(completion).rejects.toThrow('memory_context_unavailable');
    await waiting.promise;
    await changeReference();
    resume.resolve();
    await refused;
  }
  it.each(['corrected', 'forgotten'] as const)(
    `refuses a loaded reference %s ${stage} while invalidation is pending`, refusesChangedReference);
}

async function acceptsCurrentLoadedReferences() {
  const setup = await loadedRecallFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const reply = { ...setup.pending, type: 'recall_loaded' };
  const tools = await load.complete(reply);
  expect(tools).toEqual(rememberOffer());
  expect(checkPrivateTurnTools(tools, setup.input)).toBe(true);
}
it('accepts recall discovery while loaded references are still current',
  acceptsCurrentLoadedReferences);

async function refusesCompetingRecallLoad() {
  const setup = await loadedRecallFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function delayedPermission(...args: Parameters<typeof setup.realCheck>) {
    waiting.resolve();
    await resume.promise;
    return setup.realCheck(...args);
  }
  setup.check.mockImplementationOnce(delayedPermission);
  const reply = { ...setup.pending, type: 'recall_loaded' };
  const completion = load.complete(reply);
  const refused = expect(completion).rejects.toThrow('memory_context_unavailable');
  await waiting.promise;
  expect(setup.append).not.toHaveBeenCalled();
  const otherFact = { ...setup.journey.memoryWrittenExample,
    scopeId: setup.journey.scopeId, memoryId: 'other' };
  await setup.journey.append(`scope-${setup.journey.scopeId}`, 'memory.written', otherFact);
  const otherReference = { ...setup.journey.reference, memoryId: 'other' };
  const otherCall = { callDigest: 'c'.repeat(64), dispatchDigest: 'd'.repeat(64) };
  await setup.journey.load([otherReference], otherCall);
  setup.append.mockClear();
  resume.resolve();
  await refused;
}
it('refuses completion when another recall loads references after its snapshot',
  refusesCompetingRecallLoad);

async function confirmsRecallBeforeRelease() {
  const setup = await recallLoadFixture();
  const load = await preparePersonalRecallLoad(setup.input, setup.pending);
  await expect(load.confirm()).rejects.toThrow('memory_context_unavailable');
  const reply = { ...setup.pending, type: 'recall_loaded' };
  await load.complete(reply);
  await expect(load.confirm()).resolves.toBeUndefined();
  await removal(setup);
  setup.deployment.remove();
  await expect(load.confirm()).rejects.toThrow(MemberAccessRefused);
}
it('requires completed discovery and repeats membership before releasing credentials',
  confirmsRecallBeforeRelease);
