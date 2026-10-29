import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as processes from 'node:child_process';
import type { TurnSummary } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, MemberAccessRefused, privateCallers } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { privateToolOffer } from './support/private-catalogue.ts';
import { preparePersonalMemoryTools } from '../src/chat/personal-memory-tools.ts';
import { checkPrivateTurnTools, type TurnToolServerState } from '../src/chat/turn-tools.ts';
import { correctTool, forgetTool, recallTool, rememberTool } from '../src/memory/mcp.ts';

async function cryptoModule() {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, createDecipheriv: vi.fn(actual.createDecipheriv) };
}
async function processModule() {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn(actual.spawn) };
}
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

async function fixture(operation: Operation = 'recall', role = 'owner') {
  const nats = await natsFixture();
  onTestFinished(nats.close);
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  async function save(subject: string, type: string, data: unknown, apply = true) {
    const event = envelope('test', subject, type, data);
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
  vi.mocked(processes.spawn).mockClear();
  function noEffects() {
    expect(append).not.toHaveBeenCalled();
    expect(crypto.createDecipheriv).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
  }
  onTestFinished(noEffects);
  return { input, auth, check, use, realCheck, realUse, save, registration, state };
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
