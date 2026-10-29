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

async function fixture(operation: typeof operations[number] = 'recall', role = 'owner') {
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
  const definition = JSON.stringify(definitions[operation]);
  const revision = losslessJson(definition).digest;
  const state: TurnToolServerState = {
    serverId: 'memory', connectionId: 'server', published: true, accountMode: 'none',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    discoveryTools: [{ name: operation, definition, revision }],
    policyTools: [{ name: operation, revision, reviewed: true, costCents: 0, mode: 'allow' }],
  };
  async function readServer() { return state; }
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
  return { input, auth, check, use, save, registration, state };
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
async function refusesBeforeFailure(service: 'catalogue' | 'permission') {
  const setup = await fixture();
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
it.each(['catalogue', 'permission'] as const)(
  'preserves saved removal before the unavailable %s is called', refusesBeforeFailure);

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
  async function late(eventId: string) {
    const result = await applied(eventId);
    vi.spyOn(performance, 'now').mockReturnValue(now + 10_001);
    return result;
  }
  vi.spyOn(auth, 'applied').mockImplementationOnce(late);
  expect(await preparePersonalMemoryTools(input)).toEqual([]);
  expect(check.mock.calls.length).toBeLessThanOrEqual(1);
  expect(use.mock.calls.length).toBeLessThanOrEqual(2);
  vi.mocked(performance.now).mockRestore();
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

const changes = ['removal', 'grant', 'activity', 'caller', 'generation', 'qualification'] as const;
async function changesDuringRead(change: typeof changes[number]) {
  const setup = await fixture();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  async function readServer() {
    started.resolve();
    await resume.promise;
    return setup.state;
  }
  setup.input.readServer.mockImplementation(readServer);
  const preparing = preparePersonalMemoryTools(setup.input);
  const result = Promise.allSettled([preparing]);
  await started.promise;
  if (change === 'removal') await removal(setup);
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
      size: 1, sha256: 'a'.repeat(64), mime: 'text/plain',
    }, false);
  }
  if (change === 'caller') setup.registration.close();
  if (change === 'generation') setup.input.grant.inputGeneration += 1;
  if (change === 'qualification') setup.input.qualification = {
    ...setup.input.qualification, result: 'FAIL',
  };
  resume.resolve();
  const [outcome] = await result;
  if (change === 'removal') {
    expect(outcome).toMatchObject({ status: 'rejected', reason: expect.any(MemberAccessRefused) });
  } else {
    expect(outcome?.status).toBe('fulfilled');
    if (outcome?.status === 'fulfilled') {
      expect(outcome.value).toHaveLength(change === 'activity' ? 1 : 0);
      if (change === 'activity') expect(checkPrivateTurnTools(outcome.value, setup.input)).toBe(true);
    }
  }
  expect(setup.check.mock.calls.length).toBeLessThanOrEqual(1);
  expect(setup.use.mock.calls.length).toBeLessThanOrEqual(2);
}
it.each(changes)('confirms %s after a delayed catalogue read', changesDuringRead);

async function removalDuringFailure(service: 'catalogue' | 'permission') {
  const setup = await fixture();
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
it.each(['catalogue', 'permission'] as const)(
  'preserves removal saved during a failing %s read without another decision', removalDuringFailure);
