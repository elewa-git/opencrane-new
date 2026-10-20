import { once } from 'node:events';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { connectBridge } from '../src/chat/bridge.ts';
import { envelope } from '@opencrane/models';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventStore } from '@opencrane/event-store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { history, ingestUsage, parseMemoryRequest, readToolPolicy, startDecision, BudgetActor, priceTableId } from '@opencrane/models';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import * as decisionAccess from '../../../libs/models/src/decision-activity.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let capability = '';
let backendRequests = 0;
const scopeId = memoryScopeId('test', 'person', 'alice');
const route = '/mcp/memory/server';
const recallTool = toolEvidence({ name: 'recall', reviewed: true, costCents: 0 });
const rememberTool = toolEvidence({ name: 'remember', reviewed: true, costCents: 0 });
const memoryCatalogue = catalogueEvidence([recallTool, rememberTool]);
const metadata = { threadId: 'thread', callId: 'memory-dispatch',
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {} };
const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name: 'recall', arguments: { scopeId }, _meta: metadata } };
const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
  'mcp-name': 'recall' };
function memberId() {
  return Promise.resolve('alice');
}
async function govern(target: typeof setup) {
  const registration = { serverId: 'memory', kind: 'hosted', registeredBy: 'alice',
    locator: `registry.example.test/memory@sha256:${'a'.repeat(64)}` };
  await target.append('mcp-memory', 'mcp.server_registered', registration);
  const discovery = { serverId: 'memory', connectionId: 'server', accountMode: 'none',
    ...memoryCatalogue };
  await target.append('mcp-memory', 'mcp.server_discovered', discovery);
  await reviewCatalogue(target, 'memory');
  for (const tool of [recallTool, rememberTool]) {
    const mode = { serverId: 'memory', connectionId: 'server', toolName: tool.name,
      toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
    await target.append('mcp-memory', 'mcp.tool_mode_set', mode);
  }
  const published = { serverId: 'memory', publishedBy: 'alice' };
  await target.append('mcp-memory', 'mcp.server_published', published);
}
async function prepare() {
  setup = undefined!;
  app = undefined!;
  setup = await fixture(2000, 20000, false, 'gpt-6-luna', false, 'manual', 'sales', 'restricted');
  await setup.stopDispatch();
  await setup.runtime.stop();
  await govern(setup);
  const resources = [['mcp_server', 'memory'], ['memory_read', scopeId], ['memory_write', scopeId]] as const;
  for (const [resourceType, resourceId] of resources) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
      const grant = { resourceType, resourceId, granteeKind, granteeId, grantedBy: 'alice' };
      const saved = await setup.append(grantStream(resourceType, resourceId), 'grant.given', grant);
      await setup.auth.handler.handle(saved, setup.db);
    }
  }
  const keyDirectory = dirname(setup.options.configFile);
  const keys = memoryKeys(keyDirectory);
  const projectionOptions = { decrypt: keys.decrypt };
  const projection = memoryProjection(projectionOptions);
  await setup.runner.initialise(projection);
  const memory = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId }, identity: setup.identity, keyDirectory,
    dispatchGeneration: 'memory-instance' };
  app = buildServer(testAuthConfig(), { memory });
  function capture(request: import('fastify').FastifyRequest,
    _reply: import('fastify').FastifyReply, done: () => void) {
    backendRequests += 1;
    capability = String(request.headers['x-memory-context'] ?? '');
    done();
  }
  app.addHook('preHandler', capture);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const upstream = new URL(address).host;
  const configured = { serverId: 'memory', connectionId: 'server', upstream,
    generation: 'memory-instance', revisionHeader: 'x-opencrane-mcp-revision' as const };
  setup.options.mcpRoutes.push(configured);
  await setup.restart();
  const discoveryHeaders = { ...headers, 'mcp-method': 'tools/list', 'mcp-name': '' };
  const discovery = { ...call, method: 'tools/list', params: { _meta: metadata } };
  await setup.call(discoveryHeaders, discovery, route);
}
async function close() {
  const currentApp = app;
  app = undefined!;
  await currentApp?.close();
  const currentSetup = setup;
  setup = undefined!;
  await currentSetup?.close();
}
async function renewCredentials() {
  const claims = decodeJwt(setup.headers['x-turn-token']);
  setup.credentialTime(Math.floor(Date.now() / 1000) - z.int().parse(claims.iat));
  const renewed = await setup.issue();
  Object.assign(setup.headers, renewed);
}
beforeEach(prepare, 120_000);
beforeEach(renewCredentials);
afterEach(close);

async function memoryBinding(target: typeof setup) {
  const policy = await readToolPolicy(target.nats.store, 'test', 'memory');
  const bytes = randomBytes(32);
  return { permitDigest: bytes.toString('hex'), backendGeneration: 'memory-instance',
    schemaDigest: memoryCatalogue.schemaDigest, policyRevision: policy.policyRevision };
}
async function signedRecall(target: typeof setup, overrides = {}, body = call) {
  const parsed = parseMemoryRequest(JSON.stringify(body), headers);
  const dispatch = await memoryBinding(target);
  const claims = { silo: 'test', requester: 'alice', assistant: 'assistant',
    computer: 'computer', generation: 1, conversation: 'conversation', turn: 'turn',
    thread: 'thread', operation: 'recall', scopes: [scopeId], contentAccess: 'private',
    bodyDigest: parsed.bodyDigest, callId: body.params._meta.callId, dispatch,
    requestId: '11111111-1111-4111-8111-111111111111', contextPosition: 0, ...overrides };
  return target.tokens.memoryContext(claims, Date.now() + 2000);
}

async function memoryPass(body: unknown, toolName: string) {
  const requestHeaders = { ...setup.headers, ...headers, 'mcp-name': toolName };
  const request = { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) };
  const response = await fetch(`${setup.options.decisionUrl}/authorize${route}`, request);
  expect(response.status, await response.text()).toBe(200);
  const permit = response.headers.get('x-opencrane-mcp-permit');
  expect(permit).toBeTruthy();
  return permit!;
}

function dispatchMemory(permit: string, body: unknown) {
  const requestHeaders = { 'content-type': 'application/json',
    'x-opencrane-mcp-permit': permit };
  const request = { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) };
  return fetch(`${setup.options.decisionUrl}/dispatch${route}`, request);
}

const dispatchChanges = ['block', 'hold', 'generation', 'catalogue'] as const;
async function refusesChangedMemory(change: typeof dispatchChanges[number], operation: string) {
  let body: unknown = call;
  if (operation === 'remember') {
    const argumentsValue = { scopeId, commandId: `dispatch-${change}`, text: 'Fact',
      kind: 'fact', pinned: false, expiresAt: null, sources: [], dependsOn: [], recallProof: 'proof' };
    body = { ...call, params: { ...call.params, name: 'remember', arguments: argumentsValue } };
  }
  const permit = await memoryPass(body, operation);
  const configured = setup.options.mcpRoutes.at(-1)!;
  const generation = configured.generation;
  const append = setup.nats.store.append.bind(setup.nats.store);
  let changed = false;
  async function changeBeforeAdmission(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted' && !changed) {
      changed = true;
      if (change === 'generation') {
        configured.generation = 'replacement';
      } else if (change === 'block') {
        const tool = operation === 'recall' ? recallTool : rememberTool;
        const policy = { serverId: 'memory', connectionId: 'server', toolName: operation,
          toolRevision: tool.revision, mode: 'block', setBy: 'alice' };
        await setup.append('mcp-memory', 'mcp.tool_mode_set', policy);
      } else if (change === 'catalogue') {
        const changedCatalogue = { serverId: 'memory',
          previousSchemaDigest: memoryCatalogue.schemaDigest, newSchemaDigest: 'b'.repeat(64) };
        await setup.append('mcp-memory', 'mcp.tools_changed', changedCatalogue);
      } else {
        const outcome = 'failed';
        const checkedAt = new Date().toISOString();
        const check = { serverId: 'memory', outcome, checkedAt, reason: 'discovery_timeout' };
        await setup.append('mcp-memory', 'mcp.catalogue_checked', check);
      }
    }
    return append(command);
  }
  const delayed = vi.spyOn(setup.nats.store, 'append');
  delayed.mockImplementation(changeBeforeAdmission);
  capability = '';
  backendRequests = 0;
  try {
    const response = await dispatchMemory(permit, body);
    expect(changed).toBe(true);
    expect(response.status).toBe(403);
    expect(capability).toBe('');
    expect(backendRequests).toBe(0);
    if (change === 'hold') {
      const policy = await readToolPolicy(setup.nats.store, 'test', 'memory');
      expect(policy.expiresAt).toBeNull();
    }
  } finally {
    delayed.mockRestore();
    if (generation === undefined) {
      delete configured.generation;
    } else {
      configured.generation = generation;
    }
    await govern(setup);
    if (change === 'catalogue') {
      const held = await readToolPolicy(setup.nats.store, 'test', 'memory');
      expect(held.published).toBe(false);
    }
  }
}
async function refusesChangedRecall(change: typeof dispatchChanges[number]) {
  await refusesChangedMemory(change, 'recall');
}
async function refusesChangedRemember(change: typeof dispatchChanges[number]) {
  await refusesChangedMemory(change, 'remember');
}
it.each(dispatchChanges)('stops recall before the backend after a saved %s', refusesChangedRecall);
it.each(dispatchChanges)('stops remember before the backend after a saved %s', refusesChangedRemember);

async function refusesMemoryReplay() {
  const permit = await memoryPass(call, 'recall');
  const first = await dispatchMemory(permit, call);
  expect(first.status, await first.text()).toBe(200);
  const captured = capability;
  const hash = createHash('sha256');
  hash.update(permit);
  const policy = await readToolPolicy(setup.nats.store, 'test', 'memory');
  const expectedDispatch = { permitDigest: hash.digest('hex'),
    backendGeneration: 'memory-instance', schemaDigest: memoryCatalogue.schemaDigest,
    policyRevision: policy.policyRevision };
  const expectedContext = { dispatch: expectedDispatch };
  expect(decodeJwt(captured)).toMatchObject(expectedContext);
  const second = await dispatchMemory(permit, call);
  expect(second.status).toBe(403);
  const requestHeaders = { ...headers, 'x-memory-context': captured };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
  const replay = await app.inject(request);
  expect(replay.statusCode).toBe(403);
}
it('consumes the memory pass and captured backend context once', refusesMemoryReplay);

async function refusesCapturedMemoryContext() {
  const first = await setup.call(headers, call, route);
  expect(first.status, first.text).toBe(200);
  const requestHeaders = { ...headers, 'x-memory-context': capability };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
  const replay = await app.inject(request);
  expect(replay.statusCode).toBe(403);
}
it('refuses direct replay of the signed memory context', refusesCapturedMemoryContext);

const backendChanges = ['generation', 'catalogue', 'policy'] as const;
async function refusesChangedBackendContext(change: typeof backendChanges[number]) {
  const dispatch = await memoryBinding(setup);
  if (change === 'generation') {
    dispatch.backendGeneration = 'replacement';
  } else if (change === 'catalogue') {
    dispatch.schemaDigest = 'b'.repeat(64);
  } else {
    dispatch.policyRevision += 1;
  }
  const token = await signedRecall(setup, { dispatch });
  const requestHeaders = { ...headers, 'x-memory-context': token };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
  const response = await app.inject(request);
  expect(response.statusCode).toBe(403);
}
it.each(backendChanges)('checks the signed %s binding at the memory backend',
  refusesChangedBackendContext);

async function refusesReplayAfterRestart() {
  const first = await setup.call(headers, call, route);
  expect(first.status, first.text).toBe(200);
  const captured = capability;
  const memory = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId }, identity: setup.identity,
    dispatchGeneration: 'memory-instance', keyDirectory: dirname(setup.options.configFile) };
  const restarted = buildServer(testAuthConfig(), { memory });
  try {
    const requestHeaders = { ...headers, 'x-memory-context': captured };
    const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
    const response = await restarted.inject(request);
    expect(response.statusCode).toBe(403);
    const nextCall = recallCall('after-restart');
    const fresh = await signedRecall(setup, {}, nextCall);
    const freshHeaders = { ...headers, 'x-memory-context': fresh };
    const freshRequest = { ...request, headers: freshHeaders, payload: nextCall };
    const allowed = await restarted.inject(freshRequest);
    expect(allowed.statusCode, allowed.body).toBe(200);
  } finally {
    await restarted.close();
  }
}
it('refuses a captured memory context after the backend restarts', refusesReplayAfterRestart);

async function consumesConcurrentContextOnce() {
  const token = await signedRecall(setup);
  const requestHeaders = { ...headers, 'x-memory-context': token };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
  const responses = await Promise.all([app.inject(request), app.inject(request)]);
  function status(response: (typeof responses)[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(status);
  statuses.sort();
  expect(statuses).toEqual([200, 403]);
}
it('consumes concurrent copies of one signed context only once', consumesConcurrentContextOnce);

async function allowsConcurrentMemory() {
  const secondCall = recallCall('concurrent-second');
  const passes = await Promise.all([memoryPass(call, 'recall'), memoryPass(secondCall, 'recall')]);
  const first = passes[0];
  const second = passes[1];
  const append = setup.nats.store.append.bind(setup.nats.store);
  const bothReady = Promise.withResolvers<void>();
  let admissions = 0;
  async function overlap(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'mcp.dispatch_admitted') {
      admissions += 1;
      if (admissions === 2) {
        bothReady.resolve();
      }
      await bothReady.promise;
    }
    return append(command);
  }
  const delayed = vi.spyOn(setup.nats.store, 'append');
  delayed.mockImplementation(overlap);
  const before = backendRequests;
  try {
    const replies = await Promise.all([dispatchMemory(first, call), dispatchMemory(second, secondCall)]);
    const statuses = [];
    for (const reply of replies) {
      statuses.push(reply.status);
    }
    expect(statuses).toContain(200);
    expect(statuses.every(allowedOrConflict)).toBe(true);
    expect(admissions).toBe(3);
    expect(backendRequests).toBe(before + 2);
  } finally {
    bothReady.resolve();
    delayed.mockRestore();
  }
}
function allowedOrConflict(status: number) {
  return status === 200 || status === 403;
}
it('serialises evidence for concurrent memory calls on the same tool', allowsConcurrentMemory);

async function refusesStoppedMemory() {
  const permit = await memoryPass(call, 'recall');
  const before = backendRequests;
  const admissions = setup.actor.state.dispatches.length;
  const limit = { scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 0, setBy: 'alice' };
  await setup.actor.configure(limit);
  const response = await dispatchMemory(permit, call);
  expect(response.status, await response.text()).toBe(403);
  expect(backendRequests).toBe(before);
  expect(admissions).toBeGreaterThan(0);
  expect(setup.actor.state.dispatches).toHaveLength(admissions);
  expect(setup.actor.state.reservations).toEqual([]);
  await setup.actor.configure({ ...limit, ceilingCents: 20000 });
  await renewCredentials();
  const renewed = await setup.call(headers, call, route);
  expect(renewed.status, renewed.text).not.toBe(200);
  expect(backendRequests).toBe(before);
}
it('stops memory before the shared gate and keeps the renewed turn stopped', refusesStoppedMemory);

function recallCall(callId: string) {
  const selectedMetadata = { ...metadata, callId };
  return { ...call, params: { ...call.params, _meta: selectedMetadata } };
}
async function directRecall(callId: string, limit = 20) {
  const recalled = recallCall(callId);
  const body = { ...recalled, params: { ...recalled.params, arguments: { scopeId, limit } } };
  const token = await signedRecall(setup, {}, body);
  const requestHeaders = { ...headers, 'x-memory-context': token };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: body };
  return app.inject(request);
}
async function savedContext() {
  return readChatFacts(setup.nats.store, 'test', 'conversation', 'turn');
}
async function seedRecallFact(memoryId = 'private-fact', expiresAt: string | null = null,
  dependsOn: { scopeId: string; memoryId: string; revision: number }[] = []) {
  const keys = memoryKeys(dirname(setup.options.configFile));
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId, revision: 1 };
  keys.provision(identity);
  const data = { ...identity, schemaVersion: 1, kind: 'fact', pinned: false,
    expiresAt, sources: [], dependsOn, ...keys.encrypt(identity, 'Private canary') };
  const { silo: _silo, ...fields } = data;
  await setup.append(`scope-${scopeId}`, 'memory.written', fields);
  const projectionOptions = { decrypt: keys.decrypt };
  const projection = memoryProjection(projectionOptions);
  await setup.runner.run(projection);
}
async function recordsBeforeDelivery() {
  await seedRecallFact();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const stages: string[] = [];
  async function observe(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success) {
      stages.push(parsed.data.data.action);
      expect(JSON.stringify(command.event)).not.toContain('Private canary');
    }
    return append(command);
  }
  const spy = vi.spyOn(setup.nats.store, 'append');
  spy.mockImplementation(observe);
  try {
    const response = await directRecall('first');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Private canary');
    expect(stages).toEqual(['prepared', 'loaded']);
    const expected = { memoryContext: { recallCalls: 1, references: [
      { scopeId, memoryId: 'private-fact', revision: 1 }], executionAvailable: false } };
    expect(await savedContext()).toMatchObject(expected);
    const cold = { readStream: setup.nats.store.readStream.bind(setup.nats.store) };
    expect(await readChatFacts(cold, 'test', 'conversation', 'turn')).toMatchObject(expected);
  } finally {
    spy.mockRestore();
  }
}
it('records complete text-free evidence before returning recalled text', recordsBeforeDelivery);

async function uncertainEvidence(stage: 'prepared' | 'loaded' | 'saved') {
  await seedRecallFact();
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function lose(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    const action = parsed.success ? parsed.data.data.action : undefined;
    if (action === stage || (stage === 'saved' && action === 'loaded')) {
      if (stage === 'saved') {
        await append(command);
      }
      return { status: 'unavailable' as const, cause: new Error('Lost append reply') };
    }
    return append(command);
  }
  const spy = vi.spyOn(setup.nats.store, 'append');
  spy.mockImplementation(lose);
  try {
    const response = await directRecall('uncertain');
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Private canary');
    expect(response.body).not.toContain('recallProof');
  } finally {
    spy.mockRestore();
  }
  if (stage === 'saved') {
    expect((await savedContext()).memoryContext?.references).toHaveLength(1);
    expect((await directRecall('uncertain')).statusCode).toBe(403);
  }
}
it.each(['prepared', 'loaded', 'saved'] as const)(
  'releases no text or proof after uncertain %s evidence', uncertainEvidence);

async function refusesRepeatedCalls() {
  for (let index = 0; index < 4; index++) {
    const response = await directRecall(`empty-${index}`);
    expect(response.statusCode, response.body).toBe(200);
  }
  expect((await directRecall('empty-0')).statusCode).toBe(403);
  expect((await directRecall('empty-4')).statusCode).toBe(403);
  expect((await savedContext()).memoryContext?.recallCalls).toBe(4);
}
it('counts empty replies and refuses repeats and a fifth recall', refusesRepeatedCalls);

async function changesAfterLoad(change: 'key' | 'expiry' | 'close') {
  await seedRecallFact();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let restoreClock: (() => void) | undefined;
  async function changeAfterAppend(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.action === 'loaded') {
      if (change === 'key') {
        const keys = memoryKeys(dirname(setup.options.configFile));
        const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
          ownerId: 'alice', memoryId: 'private-fact', revision: 1 };
        keys.delete(identity);
      } else if (change === 'expiry') {
        const expired = Date.now() + 3000;
        const clock = vi.spyOn(Date, 'now');
        clock.mockReturnValue(expired);
        function restore() {
          clock.mockRestore();
        }
        restoreClock = restore;
      } else {
        const closed = { conversationId: 'conversation', closedBy: 'alice' };
        await setup.append('participation-conversation', 'conversation.closed', closed);
      }
    }
    return saved;
  }
  const spy = vi.spyOn(setup.nats.store, 'append');
  spy.mockImplementation(changeAfterAppend);
  try {
    const response = await directRecall('changed');
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Private canary');
    expect((await savedContext()).memoryContext?.references).toHaveLength(1);
  } finally {
    spy.mockRestore();
    restoreClock?.();
  }
}
it.each(['key', 'expiry', 'close'] as const)(
  'withholds a saved recall when %s changes before release', changesAfterLoad);

async function waitsForEvidence() {
  const append = setup.nats.store.append.bind(setup.nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function holdLoaded(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.action === 'loaded') {
      entered.resolve();
      await release.promise;
    }
    return append(command);
  }
  let delivered = false;
  function received(response: Awaited<ReturnType<typeof directRecall>>) {
    delivered = true;
    return response;
  }
  const spy = vi.spyOn(setup.nats.store, 'append');
  spy.mockImplementation(holdLoaded);
  const pending = directRecall('pending').then(received);
  try {
    await entered.promise;
    expect(delivered).toBe(false);
    release.resolve();
    expect((await pending).statusCode).toBe(200);
  } finally {
    release.resolve();
    spy.mockRestore();
  }
}
it('waits for the loaded append before completing the recall reply', waitsForEvidence);

const closeOrders = ['before prepared', 'before loaded', 'after loaded'] as const;
async function replaysRecallClosedDuringAppend(order: typeof closeOrders[number]) {
  await seedRecallFact();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const stages: string[] = [];
  let closed = false;
  async function closeConversation() {
    const data = { conversationId: 'conversation', closedBy: 'alice' };
    await setup.append('participation-conversation', 'conversation.closed', data);
    closed = true;
    stages.push('closed');
    expect(await savedContext()).toMatchObject({ turnEnded: false, conversationClosed: true });
  }
  async function raceClose(command: Parameters<typeof append>[0]) {
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (!parsed.success) {
      return append(command);
    }
    const action = parsed.data.data.action;
    if (order === `before ${action}`) {
      await closeConversation();
    }
    const saved = await append(command);
    expect(saved.status).toBe('appended');
    stages.push(action);
    if (order === 'after loaded' && action === 'loaded') {
      await closeConversation();
    }
    return saved;
  }
  const spy = vi.spyOn(setup.nats.store, 'append');
  spy.mockImplementation(raceClose);
  try {
    const response = await directRecall('closing');
    expect(closed).toBe(true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
    expect(response.body).not.toContain('Private canary');
    expect(response.body).not.toContain('recallProof');
    let expectedStages = ['prepared', 'loaded', 'closed'];
    let references = [{ scopeId, memoryId: 'private-fact', revision: 1 }];
    let recallCalls = 1;
    if (order === 'before prepared') {
      expectedStages = ['closed', 'prepared'];
      references = [];
      recallCalls = 0;
    } else if (order === 'before loaded') {
      expectedStages = ['prepared', 'closed', 'loaded'];
    }
    expect(stages).toEqual(expectedStages);
    const expected = { turnEnded: false, conversationClosed: true, memoryContext: {
      status: 'ended', reason: 'ended', references, recallCalls, executionAvailable: false } };
    // Use the writer's cached summary and a separate store identity for cold replay.
    const cold = { readStream: setup.nats.store.readStream.bind(setup.nats.store) };
    await expect.soft(savedContext()).resolves.toMatchObject(expected);
    await expect.soft(readChatFacts(cold, 'test', 'conversation', 'turn'))
      .resolves.toMatchObject(expected);
    expect((await directRecall('after-close')).json()).toEqual({ status: 'refused' });
    expect(stages).toEqual(expectedStages);
  } finally {
    spy.mockRestore();
  }
}
it.each(closeOrders)('retains ended recall accounting when closure lands %s',
  replaysRecallClosedDuringAppend);

async function refusesCallsAfterClose(subject: string) {
  const permit = await memoryPass(call, 'recall');
  expect((await setup.call()).status).toBe(200);
  expect(setup.received()).toBe(1);
  const reservations = setup.actor.state.reservations.length;
  const dispatches = setup.actor.state.dispatches.length;
  const received = backendRequests;
  await setup.append(subject, 'conversation.closed', {
    conversationId: 'conversation', closedBy: 'alice',
  });
  const model = await setup.call();
  expect(model.status, model.text).toBe(403);
  const memory = await setup.call(headers, call, route);
  expect(memory.status, memory.text).toBe(403);
  const dispatched = await dispatchMemory(permit, call);
  expect(dispatched.status, await dispatched.text()).toBe(403);
  expect(backendRequests).toBe(received);
  expect(setup.received()).toBe(1);
  expect(setup.actor.state.reservations).toHaveLength(reservations);
  expect(setup.actor.state.dispatches).toHaveLength(dispatches);
  const reservationId = setup.actor.state.reservations[0]!.id;
  async function settleUsage() {
    await ingestUsage(setup.actor, setup.options.usageFile);
    const effects = await history(setup.nats.store, `effect-${reservationId}`, 'test');
    for (const row of effects) {
      if (row.event.type === 'effect.observed') {
        await setup.actor.settleRecorded(reservationId, row.event.id);
      }
    }
    return setup.actor.state.reservations[0]?.settledCents !== undefined;
  }
  // Run the normal settlement command while this fixture's background worker is paused.
  await until(settleUsage);
  await settleUsage();
  expect(setup.actor.state.reservations[0]?.settledCents).toBeGreaterThan(0);
  const settlements = [];
  for await (const row of setup.nats.store.readStream('budget-test')) {
    if (row.event.type === 'budget.settled') settlements.push(row);
  }
  expect(settlements).toHaveLength(1);
}
it.each(['conversation-conversation', 'participation-conversation'])(
  'refuses new model and memory calls after %s closes and settles dispatched usage once',
  refusesCallsAfterClose);

async function refusesStoppedRootMemory(reason: 'requester_stop' | 'allowance_exhausted') {
  const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
    threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
    payingGroupId: 'personal-default', allowanceCents: 1000 };
  const root = await setup.actor.setRootAllowance(binding, 1);
  const permit = await memoryPass(call, 'recall');
  if (reason === 'requester_stop') {
    const subject = 'conversation-conversation';
    const payload = { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' };
    await setup.append(subject, 'agent.turn_stop_requested', payload);
    const position = await setup.nats.store.head(subject);
    await setup.actor.stopRoot(root.rootId, 'requester_stop', subject, position);
  } else {
    // Stop only the root so a conversation Stop cannot hide a missing memory check.
    const modelCall = { ...binding, model: 'gpt-6-luna', priceTableId,
      contextDigest: '0'.repeat(64) };
    await expect(setup.actor.reserve(modelCall, 1001, undefined, undefined, root.rootId))
      .rejects.toMatchObject({ reason: 'allowance_exhausted' });
  }
  const before = await setup.nats.store.head();
  const beforeRequests = backendRequests;
  expect((await dispatchMemory(permit, call)).status).toBe(403);
  expect(backendRequests).toBe(beforeRequests);
  expect(await setup.nats.store.head()).toBe(before);
  const response = await setup.call(headers, call, route);
  expect(response.status).toBe(403);
  expect(backendRequests).toBe(beforeRequests);
}
it.each(['requester_stop', 'allowance_exhausted'] as const)(
  'refuses an old memory permit and a new grant after root %s', refusesStoppedRootMemory);

async function refusesForgottenLoadedFact() {
  await seedRecallFact();
  const recalled = await directRecall('loaded-before-model');
  expect(recalled.statusCode, recalled.body).toBe(200);
  const forgotten = { scopeId, memoryId: 'private-fact' };
  await setup.append(`scope-${scopeId}`, 'memory.forgotten', forgotten);
  const response = await setup.call();
  expect(response.status, response.text).toBe(403);
  expect(setup.received()).toBe(0);
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.actor.state.dispatches).toHaveLength(1);
}
it('refuses a model call after a loaded fact is forgotten', refusesForgottenLoadedFact);

const loadedChanges = ['correct', 'forget', 'member_read', 'assistant_read',
  'member_mcp', 'assistant_mcp'] as const;
type LoadedChange = typeof loadedChanges[number];
async function changeLoadedMemory(change: LoadedChange, memoryId = 'private-fact') {
  if (change === 'forget' || change === 'correct') {
    const fields = { scopeId, memoryId };
    if (change === 'forget') {
      await setup.append(`scope-${scopeId}`, 'memory.forgotten', fields);
    } else {
      const corrected = { ...fields, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        keyId: `key:${'a'.repeat(64)}` };
      await setup.append(`scope-${scopeId}`, 'memory.corrected', corrected);
    }
    return;
  }
  const resourceType = change.endsWith('read') ? 'memory_read' : 'mcp_server';
  const resourceId = resourceType === 'memory_read' ? scopeId : 'memory';
  const granteeKind = change.startsWith('member') ? 'member' : 'assistant';
  const granteeId = granteeKind === 'member' ? 'alice' : 'assistant';
  const revoked = { resourceType, resourceId, granteeKind, granteeId, revokedBy: 'alice' };
  // Leave IAM and notifications behind. Saved revocation alone must prevent the send.
  await setup.append(grantStream(resourceType, resourceId), 'grant.revoked', revoked);
}

const externalTool = toolEvidence({ name: 'read', reviewed: true, costCents: 0 });
const toolCall = { ...call, params: { ...call.params, name: 'read', arguments: {} } };
const toolHeaders = { ...headers, 'mcp-name': 'read' };
const toolRoute = '/mcp/fixture/installed';
async function prepareExternalTool() {
  const registration = { serverId: 'fixture', kind: 'remote', registeredBy: 'alice',
    locator: 'https://fixture.example.test/mcp' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogueEvidence([externalTool]) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup);
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'read',
    toolRevision: externalTool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  await setup.append('mcp-fixture', 'mcp.server_published',
    { serverId: 'fixture', publishedBy: 'alice' });
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind, granteeId, grantedBy: 'alice' };
    const saved = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(saved, setup.db);
  }
}

async function refusesChangedLoadedMemory(change: LoadedChange) {
  await prepareExternalTool();
  await seedRecallFact('first-fact');
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const dispatches = setup.actor.state.dispatches.length;
  const received = backendRequests;
  await changeLoadedMemory(change);
  const model = await setup.call();
  expect(model.status, model.text).toBe(403);
  const tool = await setup.call(toolHeaders, toolCall, toolRoute);
  expect(tool.status, tool.text).toBe(403);
  const memory = await setup.call(headers, recallCall('next'), route);
  expect(memory.status, memory.text).toBe(403);
  expect(setup.received()).toBe(0);
  expect(backendRequests).toBe(received);
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.actor.state.dispatches).toHaveLength(dispatches);
}
it.each(loadedChanges)('refuses model, tool and recall after loaded memory %s',
  refusesChangedLoadedMemory);

async function checksExpiryAtUse(offset: number) {
  const expires = Date.now() + 60_000;
  await seedRecallFact('private-fact', new Date(expires).toISOString());
  expect((await directRecall('load')).statusCode).toBe(200);
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(expires + offset);
  try {
    const response = await setup.call();
    expect(response.status, response.text).toBe(offset === -1 ? 200 : 403);
    expect(setup.received()).toBe(offset === -1 ? 1 : 0);
  } finally {
    clock.mockRestore();
  }
}
it.each([-1, 0])('checks loaded expiry at use, offset %s ms', checksExpiryAtUse);

async function refusesForgottenDependency() {
  await seedRecallFact('dependency');
  const dependency = { scopeId, memoryId: 'dependency', revision: 1 };
  await seedRecallFact('a-derived', null, [dependency]);
  expect((await directRecall('load', 1)).statusCode).toBe(200);
  const expected = [{ scopeId, memoryId: 'a-derived', revision: 1 }];
  expect((await savedContext()).memoryContext?.references).toEqual(expected);
  await changeLoadedMemory('forget', 'dependency');
  expect((await setup.call()).status).toBe(403);
  expect(setup.received()).toBe(0);
}
it('refuses a loaded fact with a forgotten dependency', refusesForgottenDependency);

async function changesBeforeFinalConfirm(change: LoadedChange, destination: 'model' | 'recall') {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const dispatches = setup.actor.state.dispatches.length;
  const received = backendRequests;
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function changeBeforeConfirm(...args: Parameters<typeof admit>) {
    await changeLoadedMemory(change);
    return admit(...args);
  }
  const spy = vi.spyOn(setup.actor, 'admitDispatch');
  spy.mockImplementation(changeBeforeConfirm);
  try {
    const response = destination === 'model' ? await setup.call()
      : await setup.call(headers, recallCall('next'), route);
    expect(response.status, response.text).toBe(403);
    expect(setup.received()).toBe(0);
    expect(backendRequests).toBe(received);
    expect(setup.actor.state.dispatches).toHaveLength(dispatches);
    for (const reservation of setup.actor.state.reservations) {
      expect(reservation.settledCents).toBe(0);
    }
  } finally {
    spy.mockRestore();
  }
}
it.each(['forget', 'assistant_read'] as const)(
  'refuses %s saved before model admission', refusesModelRace);
async function refusesModelRace(change: LoadedChange) {
  await changesBeforeFinalConfirm(change, 'model');
}
it.each(['forget', 'member_mcp'] as const)(
  'refuses %s saved before MCP confirmSend', refusesRecallRace);
async function refusesRecallRace(change: LoadedChange) {
  await changesBeforeFinalConfirm(change, 'recall');
}

async function allowsUnrelatedChanges() {
  await prepareExternalTool();
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  await seedRecallFact('unloaded');
  await changeLoadedMemory('correct', 'unloaded');
  const message = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', keyId: 'key:message',
    contentType: 'text' };
  await setup.append('conversation-conversation', 'message.posted', message);
  const upload = { conversationId: 'conversation', fileId: 'upload', uploadedBy: 'alice',
    name: 'note.txt', size: 5, sha256: 'a'.repeat(64), mime: 'text/plain',
    objectKey: 'test/conversation/upload' };
  await setup.append('conversation-conversation', 'file.uploaded', upload);
  const response = await setup.call();
  expect(response.status, response.text).toBe(200);
  const tool = await setup.call(toolHeaders, toolCall, toolRoute);
  expect(tool.status, tool.text).toBe(200);
  expect(setup.received()).toBe(2);
}
it('allows calls after an unloaded correction, a message and an upload', allowsUnrelatedChanges);

async function ignoresUnusedMemoryGrants() {
  await prepareExternalTool();
  await changeLoadedMemory('assistant_read');
  await changeLoadedMemory('member_mcp');
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  async function* noScopes(...args: Parameters<typeof read>) {
    expect(args[0]).not.toMatch(/^scope-/u);
    yield* read(...args);
  }
  const spy = vi.spyOn(setup.nats.store, 'readStream');
  spy.mockImplementation(noScopes);
  try {
    expect((await setup.call()).status).toBe(200);
    expect((await setup.call(toolHeaders, toolCall, toolRoute)).status).toBe(200);
  } finally {
    spy.mockRestore();
  }
}
it('reads no scopes and ignores memory grants without loaded references', ignoresUnusedMemoryGrants);

async function refusesAfterColdReplay() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const pending = await memoryPass(recallCall('pending'), 'recall');
  await changeLoadedMemory('forget');
  const coldStore = await createEventStore(setup.nats.connection);
  const facts = await readChatFacts(coldStore, 'test', 'conversation', 'turn');
  expect(facts.memoryContext?.executionAvailable).toBe(false);
  const actor = new BudgetActor(coldStore, 'test');
  await actor.start();
  const identity = { ...setup.identity, memory: setup.tokens };
  const decision = await startDecision(actor, identity, setup.binding, 0,
    setup.keys, undefined, setup.dispatchOptions);
  try {
    const request = { method: 'POST', headers: setup.headers, body: JSON.stringify({
      model: 'gpt-6-luna', input: 'Hello', stream: true, max_output_tokens: 128 }) };
    const response = await fetch(`${decision.url}/authorize`, request);
    expect(response.status).toBe(403);
    const refused: unknown = await response.json();
    expect(refused).toMatchObject({ error: 'memory_context_unavailable' });
    expect(response.headers.get('x-reservation-id')).toBeNull();
    const dispatchHeaders = { 'x-opencrane-mcp-permit': pending };
    const dispatchRequest = { method: 'POST', headers: dispatchHeaders,
      body: JSON.stringify(recallCall('pending')) };
    const replay = await fetch(`${decision.url}/dispatch${route}`, dispatchRequest);
    expect(replay.status).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
    expect(setup.received()).toBe(0);
  } finally {
    await decision.close();
  }
}
it('refuses loaded memory after cold decision and summary replay', refusesAfterColdReplay);

async function checksOnlyNewScopeRows(revoke: boolean) {
  await setup.slowDecisions();
  await renewCredentials();
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const position = await setup.nats.store.head(`scope-${scopeId}`);
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function unrelatedBeforeConfirm(...args: Parameters<typeof admit>) {
    await changeLoadedMemory('forget', 'unloaded');
    return admit(...args);
  }
  const admission = vi.spyOn(setup.actor, 'admitDispatch');
  admission.mockImplementation(unrelatedBeforeConfirm);
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  const starts: number[] = [];
  async function* observe(...args: Parameters<typeof read>) {
    if (args[0] === `scope-${scopeId}`) {
      starts.push(args[1] ?? 1);
      if (args[1] === 1) await delay(2100);
      if (revoke && args[1] === position + 1) await changeLoadedMemory('assistant_read');
    }
    yield* read(...args);
  }
  const spy = vi.spyOn(setup.nats.store, 'readStream');
  spy.mockImplementation(observe);
  try {
    expect((await setup.call()).status).toBe(revoke ? 403 : 200);
    expect(starts).toEqual([1, position + 1]);
    if (revoke) {
      expect(setup.received()).toBe(0);
      expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
    }
  } finally {
    spy.mockRestore();
    admission.mockRestore();
  }
}
it.each([false, true])('loads slow scope history before access and checks new rows, revoke=%s',
  checksOnlyNewScopeRows);

async function refusesPassAfterAnotherRecall() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const pending = recallCall('pending');
  const permit = await memoryPass(pending, 'recall');
  expect((await directRecall('another')).statusCode).toBe(200);
  const dispatches = setup.actor.state.dispatches.length;
  const received = backendRequests;
  const response = await dispatchMemory(permit, pending);
  expect(response.status).toBe(403);
  expect(backendRequests).toBe(received);
  expect(setup.actor.state.dispatches).toHaveLength(dispatches);
}
it('refuses an old pass after another recall changes loaded evidence', refusesPassAfterAnotherRecall);


const finalAccessRaces = [
  { destination: 'model', timing: 'during' },
  { destination: 'tool', timing: 'during' },
  { destination: 'model', timing: 'after' },
  { destination: 'tool', timing: 'after' },
  { destination: 'tool send', timing: 'during' },
  { destination: 'tool send', timing: 'after' },
] as const;
async function refusesForgetAtFinalAccess(race: typeof finalAccessRaces[number]) {
  if (race.destination !== 'model') await prepareExternalTool();
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  let dispatches = setup.actor.state.dispatches.length;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let armed = false;
  let scopeSampled = false;
  let paused = false;
  async function pauseOnce() {
    if (paused) return;
    paused = true;
    entered.resolve();
    await release.promise;
  }
  const head = setup.nats.store.head.bind(setup.nats.store);
  async function pauseMemberRead(...args: Parameters<typeof head>) {
    const position = await head(...args);
    if (armed && args[0] === `scope-${scopeId}`) scopeSampled = true;
    if (armed && scopeSampled && args[0] === 'member-alice' && race.timing === 'during') {
      await pauseOnce();
    }
    return position;
  }
  const confirm = decisionAccess.confirmDecisionAccess;
  async function pauseAfterAccess(...args: Parameters<typeof confirm>) {
    await confirm(...args);
    if (armed && scopeSampled && race.timing === 'after') await pauseOnce();
  }
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function armAtAdmission(...args: Parameters<typeof admit>) {
    if (race.destination !== 'tool send') armed = true;
    const result = await admit(...args);
    if (race.destination === 'tool send') {
      // Pause the later MCP send check, after the separate budget permission was saved.
      dispatches = setup.actor.state.dispatches.length;
      armed = true;
    }
    return result;
  }
  const headSpy = vi.spyOn(setup.nats.store, 'head');
  headSpy.mockImplementation(pauseMemberRead);
  const accessSpy = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
  accessSpy.mockImplementation(pauseAfterAccess);
  const admitSpy = vi.spyOn(setup.actor, 'admitDispatch');
  admitSpy.mockImplementation(armAtAdmission);
  const pending = race.destination === 'model' ? setup.call()
    : setup.call(toolHeaders, toolCall, toolRoute);
  try {
    await entered.promise;
    await changeLoadedMemory('forget');
    release.resolve();
    const response = await pending;
    expect.soft(response.status, response.text).toBe(403);
    expect.soft(setup.received()).toBe(0);
    expect.soft(setup.actor.state.dispatches).toHaveLength(dispatches);
    if (race.destination === 'model') {
      expect(setup.actor.state.reservations).toHaveLength(1);
    } else {
      expect(setup.actor.state.reservations).toHaveLength(0);
    }
    for (const reservation of setup.actor.state.reservations) {
      expect.soft(reservation.settledCents).toBe(0);
    }
    const admissions = [];
    for await (const row of setup.nats.store.readStream('mcp-fixture')) {
      if (row.event.type === 'mcp.dispatch_admitted') admissions.push(row);
    }
    expect.soft(admissions).toHaveLength(0);
  } finally {
    release.resolve();
    await pending;
    headSpy.mockRestore();
    accessSpy.mockRestore();
    admitSpy.mockRestore();
  }
}
it.each(finalAccessRaces)(
  'refuses $destination when a loaded forget is saved $timing final access',
  refusesForgetAtFinalAccess);

async function refusesDamagedScopeHistory(damage: 'backwards' | 'incomplete') {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  await changeLoadedMemory('forget', 'unloaded-older');
  const scopeSubject = `scope-${scopeId}`;
  const olderPosition = await setup.nats.store.head(scopeSubject);
  const olderRows = await history(setup.nats.store, scopeSubject, 'test');
  const olderRow = olderRows.at(-1)!;
  await changeLoadedMemory('forget', 'unloaded-newer');
  const position = await setup.nats.store.head(scopeSubject);
  let armed = false;
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function damageAtAdmission(...args: Parameters<typeof admit>) {
    armed = true;
    if (damage === 'incomplete') await changeLoadedMemory('forget', 'unloaded-last');
    return admit(...args);
  }
  const head = setup.nats.store.head.bind(setup.nats.store);
  async function restoredPosition(...args: Parameters<typeof head>) {
    if (armed && args[0] === scopeSubject && damage === 'backwards') return olderPosition;
    return head(...args);
  }
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  async function* damagedHistory(...args: Parameters<typeof read>) {
    if (armed && args[0] === scopeSubject) {
      expect(args[1]).toBe(position + 1);
      // Simulate a restored older snapshot, or a read missing its newest event.
      if (damage === 'backwards') yield olderRow;
      return;
    }
    yield* read(...args);
  }
  const admission = vi.spyOn(setup.actor, 'admitDispatch');
  admission.mockImplementation(damageAtAdmission);
  const headSpy = vi.spyOn(setup.nats.store, 'head');
  headSpy.mockImplementation(restoredPosition);
  const readSpy = vi.spyOn(setup.nats.store, 'readStream');
  readSpy.mockImplementation(damagedHistory);
  const dispatches = setup.actor.state.dispatches.length;
  try {
    const response = await setup.call();
    expect(response.status, response.text).toBe(403);
    expect(response.text).toContain('memory_context_unavailable');
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.dispatches).toHaveLength(dispatches);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
  } finally {
    admission.mockRestore();
    headSpy.mockRestore();
    readSpy.mockRestore();
  }
}
it.each(['backwards', 'incomplete'] as const)(
  'refuses loaded memory with %s scope history at final admission', refusesDamagedScopeHistory);

async function expiresDuringFinalAccess() {
  const expires = Date.now() + 60_000;
  await seedRecallFact('private-fact', new Date(expires).toISOString());
  expect((await directRecall('load')).statusCode).toBe(200);
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(expires - 1);
  let armed = false;
  let advanced = false;
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function armAtAdmission(...args: Parameters<typeof admit>) {
    armed = true;
    return admit(...args);
  }
  const confirm = decisionAccess.confirmDecisionAccess;
  async function advanceAfterAccess(...args: Parameters<typeof confirm>) {
    await confirm(...args);
    if (armed) {
      clock.mockReturnValue(expires);
      advanced = true;
    }
  }
  const admission = vi.spyOn(setup.actor, 'admitDispatch');
  admission.mockImplementation(armAtAdmission);
  const access = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
  access.mockImplementation(advanceAfterAccess);
  const dispatches = setup.actor.state.dispatches.length;
  try {
    const response = await setup.call();
    expect(advanced).toBe(true);
    expect(response.status, response.text).toBe(403);
    expect(response.text).toContain('memory_context_unavailable');
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.dispatches).toHaveLength(dispatches);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
  } finally {
    clock.mockRestore();
    admission.mockRestore();
    access.mockRestore();
  }
}
it('refuses loaded memory when expiry advances during final confirmation', expiresDuringFinalAccess);

async function refusesUnsettledMemoryAtDeadline() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const clock = vi.spyOn(performance, 'now');
  let armed = false;
  let rounds = 0;
  let originalDeadline: number | undefined;
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function armAtAdmission(...args: Parameters<typeof admit>) {
    armed = true;
    return admit(...args);
  }
  const confirm = decisionAccess.confirmDecisionAccess;
  async function changeAfterEachAccess(...args: Parameters<typeof confirm>) {
    await confirm(...args);
    if (!armed) return;
    originalDeadline ??= args[1].deadline;
    expect(args[1].deadline).toBe(originalDeadline);
    rounds += 1;
    await changeLoadedMemory('forget', `unloaded-${rounds}`);
    if (rounds === 3) clock.mockReturnValue(originalDeadline);
  }
  const admission = vi.spyOn(setup.actor, 'admitDispatch');
  admission.mockImplementation(armAtAdmission);
  const access = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
  access.mockImplementation(changeAfterEachAccess);
  const dispatches = setup.actor.state.dispatches.length;
  try {
    const response = await setup.call();
    expect(rounds).toBe(3);
    expect(response.status, response.text).toBe(403);
    expect(response.text).toContain('memory_context_unavailable');
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.dispatches).toHaveLength(dispatches);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
  } finally {
    clock.mockRestore();
    admission.mockRestore();
    access.mockRestore();
  }
}
it('refuses repeated memory changes at the original access deadline',
  refusesUnsettledMemoryAtDeadline);

async function renewalBridge(store = setup.nats.store, withBinding = true) {
  const message = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...setup.keys.encrypt('test', 'conversation', 'Continue') };
  const event = envelope('test', 'conversation-conversation', 'message.posted', message, 'turn');
  await setup.nats.seed([event]);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Bridge address unavailable');
  const connected = Promise.withResolvers<WebSocket>();
  const messages: unknown[] = [];
  function receive(raw: RawData) {
    if (!Buffer.isBuffer(raw)) throw new Error('Unexpected bridge message');
    messages.push(JSON.parse(raw.toString()) as unknown);
  }
  function capture(peer: WebSocket) {
    peer.on('message', receive);
    connected.resolve(peer);
  }
  server.on('connection', capture);
  const options: Parameters<typeof connectBridge>[0] = { silo: 'test', store, keys: setup.keys };
  if (withBinding) options.binding = setup.binding;
  const input = { computerId: 'computer', assistantId: 'assistant', bearer: 'fixture',
    url: `ws://127.0.0.1:${address.port}` };
  const link = await connectBridge(options, input, setup.tokens);
  const peer = await connected.promise;
  function resumed() {
    return messages.length > 0;
  }
  await until(resumed);
  async function exchange(sequence: number) {
    const count = messages.length;
    const report = { sequence, previousSequence: sequence - 1, conversationId: 'conversation',
      turnId: 'turn', assistantId: 'assistant', type: 'agent.turn_started',
      threadId: 'thread', executionMode: 'restricted' };
    peer.send(JSON.stringify(report));
    function replied() {
      return messages.length > count || link.socket.readyState === 3;
    }
    await until(replied, 5000);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
    return messages.at(-1);
  }
  async function closeBridge() {
    link.socket.terminate();
    await link.settled();
    for (const socket of server.clients) socket.terminate();
    server.close();
    await once(server, 'close');
  }
  return { exchange, close: closeBridge };
}

async function refusesMemoryRenewal(change: LoadedChange) {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  const issuance = vi.spyOn(setup.tokens, 'turn');
  try {
    expect(await bridge.exchange(1)).toHaveProperty('token');
    await changeLoadedMemory(change);
    issuance.mockClear();
    const refused = { type: 'ack', sequence: 2, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(2)).toEqual(refused);
    expect(issuance).not.toHaveBeenCalled();
    expect(await bridge.exchange(2)).toEqual(refused);
    const facts = await savedContext();
    expect(facts.memoryContext?.status).toBe('loaded');
    expect(facts.turnEnded).toBe(false);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it.each(loadedChanges)('refuses turn renewal after loaded memory %s', refusesMemoryRenewal);

async function refusesMemoryDuringSigning(change: LoadedChange) {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function changeDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    await changeLoadedMemory(change);
    return result;
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(changeDuringSigning);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).toHaveBeenCalledOnce();
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it.each(['correct', 'forget', 'assistant_read', 'member_mcp'] as const)(
  'refuses turn renewal when %s arrives during signing', refusesMemoryDuringSigning);

async function allowsMemoryRenewal(loaded: boolean) {
  if (loaded) {
    await seedRecallFact();
    expect((await directRecall('load')).statusCode).toBe(200);
    await changeLoadedMemory('forget', 'unloaded');
  } else {
    await changeLoadedMemory('assistant_read');
  }
  const bridge = await renewalBridge();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let scopeReads = 0;
  const starts: number[] = [];
  async function* countScopes(...args: Parameters<typeof read>) {
    if (args[0].startsWith('scope-')) {
      scopeReads += 1;
      starts.push(args[1] ?? 1);
      if (args[1] === 1) await delay(2100);
    }
    yield* read(...args);
  }
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function unrelatedDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    if (loaded) await changeLoadedMemory('forget', 'unloaded-during-signing');
    return result;
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementation(unrelatedDuringSigning);
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(countScopes);
  try {
    for (const sequence of [1, 2]) {
      const position = await setup.nats.store.head(`scope-${scopeId}`);
      starts.length = 0;
      const reply = await bridge.exchange(sequence);
      expect(reply).toHaveProperty('token');
      expect(reply).not.toHaveProperty('refused');
      if (loaded) expect(starts).toEqual([1, position + 1]);
    }
    if (!loaded) expect(scopeReads).toBe(0);
  } finally {
    issuance.mockRestore();
    reads.mockRestore();
    await bridge.close();
  }
}
it.each([true, false])('allows turn renewal with loaded memory %s', allowsMemoryRenewal);

async function checksRenewalExpiry(offset: number) {
  const expires = Date.now() + 60_000;
  await seedRecallFact('private-fact', new Date(expires).toISOString());
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  const issue = setup.tokens.turn.bind(setup.tokens);
  const clock = vi.spyOn(Date, 'now');
  async function advanceDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    clock.mockReturnValue(expires + offset);
    return result;
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(advanceDuringSigning);
  try {
    const reply = await bridge.exchange(1);
    if (offset === -1) {
      expect(reply).toHaveProperty('token');
    } else {
      const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
      expect(reply).toEqual(refused);
    }
  } finally {
    clock.mockRestore();
    issuance.mockRestore();
    await bridge.close();
  }
}
it.each([-1, 0])('checks turn renewal expiry at release, offset %s ms', checksRenewalExpiry);

async function refusesColdRenewal() {
  await seedRecallFact('dependency');
  const dependency = { scopeId, memoryId: 'dependency', revision: 1 };
  await seedRecallFact('a-derived', null, [dependency]);
  expect((await directRecall('load', 1)).statusCode).toBe(200);
  await changeLoadedMemory('forget', 'dependency');
  const coldStore = await createEventStore(setup.nats.connection);
  const issuance = vi.spyOn(setup.tokens, 'turn');
  const facts = await readChatFacts(coldStore, 'test', 'conversation', 'turn');
  expect(facts.memoryContext?.executionAvailable).toBe(false);
  expect(issuance).not.toHaveBeenCalled();
  const bridge = await renewalBridge(coldStore);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).not.toHaveBeenCalled();
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it('refuses turn renewal after cold replay with a forgotten dependency', refusesColdRenewal);

async function refusesNewRecallDuringRenewal() {
  const bridge = await renewalBridge();
  await seedRecallFact();
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function recallDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    expect((await directRecall('during-signing')).statusCode).toBe(200);
    return result;
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(recallDuringSigning);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it('refuses turn renewal when a recall adds references during signing',
  refusesNewRecallDuringRenewal);

async function refusesMissingRenewalBinding() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge(setup.nats.store, false);
  const issuance = vi.spyOn(setup.tokens, 'turn');
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).not.toHaveBeenCalled();
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it('refuses turn renewal with loaded references but no permissions binding',
  refusesMissingRenewalBinding);

const renewalAccessChanges = [
  { subject: 'member-alice', type: 'member.removed',
    data: { memberId: 'alice', removedBy: 'alice' } },
  { subject: 'assistant-assistant', type: 'assistant.settings_changed',
    data: { assistantId: 'assistant', active: false } },
];
async function refusesIdentityDuringRenewal(change: typeof renewalAccessChanges[number]) {
  const bridge = await renewalBridge();
  let signed = false;
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function markSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    signed = true;
    return result;
  }
  const confirm = decisionAccess.confirmDecisionAccess;
  async function removeBeforeFinalCheck(...args: Parameters<typeof confirm>) {
    if (signed) {
      signed = false;
      await setup.append(change.subject, change.type, change.data);
    }
    return confirm(...args);
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(markSigning);
  const access = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
  access.mockImplementation(removeBeforeFinalCheck);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).toHaveBeenCalledOnce();
  } finally {
    access.mockRestore();
    issuance.mockRestore();
    await bridge.close();
  }
}
it.each(renewalAccessChanges)(
  'refuses turn renewal when $type arrives during the final activity check',
  refusesIdentityDuringRenewal);

async function refusesRevocationDuringFinalScopeRead(change: LoadedChange) {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  try {
    expect(await bridge.exchange(1)).toHaveProperty('token');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let signed = false;
    let finalAccessChecked = false;
    let paused = false;
    const issue = setup.tokens.turn.bind(setup.tokens);
    async function markSigning(input: Parameters<typeof issue>[0]) {
      const result = await issue(input);
      signed = true;
      return result;
    }
    const confirm = decisionAccess.confirmDecisionAccess;
    async function observeAccess(...args: Parameters<typeof confirm>) {
      await confirm(...args);
      if (signed) finalAccessChecked = true;
    }
    const head = setup.nats.store.head.bind(setup.nats.store);
    async function pauseScopeRead(...args: Parameters<typeof head>) {
      const position = await head(...args);
      if (finalAccessChecked && !paused && args[0] === `scope-${scopeId}`) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return position;
    }
    const issuance = vi.spyOn(setup.tokens, 'turn');
    issuance.mockImplementationOnce(markSigning);
    const access = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
    access.mockImplementation(observeAccess);
    const heads = vi.spyOn(setup.nats.store, 'head');
    heads.mockImplementation(pauseScopeRead);
    const pending = bridge.exchange(2);
    try {
      await entered.promise;
      await changeLoadedMemory(change);
      release.resolve();
      const reply = await pending;
      const refused = { type: 'ack', sequence: 2, refused: 'memory_context_unavailable' };
      expect(reply).toEqual(refused);
      expect(reply).not.toHaveProperty('token');
      expect(reply).not.toHaveProperty('context');
      expect(issuance).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await pending;
      heads.mockRestore();
      access.mockRestore();
      issuance.mockRestore();
    }
  } finally {
    await bridge.close();
  }
}
it.each(['assistant_read', 'member_mcp'] as const)(
  'refuses turn renewal when %s is revoked during the final scope read',
  refusesRevocationDuringFinalScopeRead);

type MemoryBoundaryTiming = 'last_scope_read' | 'final_access_read';
async function checkRenewalMemoryBoundary(change: 'correct' | 'forget',
  timing: MemoryBoundaryTiming) {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  try {
    expect(await bridge.exchange(1)).toHaveProperty('token');
    const issue = setup.tokens.turn.bind(setup.tokens);
    let signed = false;
    let scopeReads = 0;
    let changed = false;
    async function markSigning(input: Parameters<typeof issue>[0]) {
      const result = await issue(input);
      signed = true;
      return result;
    }
    const head = setup.nats.store.head.bind(setup.nats.store);
    async function changeAtBoundary(...args: Parameters<typeof head>) {
      if (signed && args[0] === `scope-${scopeId}`) {
        scopeReads += 1;
        // Save before the second read so its exact position includes the change.
        if (scopeReads === 2 && timing === 'last_scope_read') {
          changed = true;
          await changeLoadedMemory(change);
        }
      }
      const position = await head(...args);
      if (signed && scopeReads === 2 && !changed && args[0] === 'member-alice'
        && timing === 'final_access_read') {
        // Finish saving while the final access read is still waiting to return.
        changed = true;
        await changeLoadedMemory(change);
      }
      return position;
    }
    const issuance = vi.spyOn(setup.tokens, 'turn');
    issuance.mockImplementationOnce(markSigning);
    const heads = vi.spyOn(setup.nats.store, 'head');
    heads.mockImplementation(changeAtBoundary);
    try {
      const reply = await bridge.exchange(2);
      expect(changed).toBe(true);
      expect(issuance).toHaveBeenCalledOnce();
      let refusedSequence = 2;
      if (timing === 'final_access_read') {
        expect(scopeReads).toBe(2);
        expect(reply).toHaveProperty('token', expect.any(String));
        expect(reply).not.toHaveProperty('context');
        expect(reply).not.toHaveProperty('refused');
        refusedSequence = 3;
      } else {
        expect(reply).toEqual({ type: 'ack', sequence: 2,
          refused: 'memory_context_unavailable' });
        expect(reply).not.toHaveProperty('token');
        expect(reply).not.toHaveProperty('context');
      }
      heads.mockRestore();
      issuance.mockClear();
      const refused = { type: 'ack', sequence: refusedSequence,
        refused: 'memory_context_unavailable' };
      const next = await bridge.exchange(refusedSequence);
      expect(next).toEqual(refused);
      expect(next).not.toHaveProperty('token');
      expect(next).not.toHaveProperty('context');
      expect(issuance).not.toHaveBeenCalled();
      expect(await bridge.exchange(refusedSequence)).toEqual(refused);
    } finally {
      heads.mockRestore();
      issuance.mockRestore();
    }
  } finally {
    await bridge.close();
  }
}
async function allowsMemoryChangeAfterScopeBoundary(change: 'correct' | 'forget') {
  await checkRenewalMemoryBoundary(change, 'final_access_read');
}
it.each(['correct', 'forget'] as const)(
  'allows %s during the final access read but refuses the next turn renewal',
  allowsMemoryChangeAfterScopeBoundary);

async function refusesMemoryChangeAtScopeBoundary(change: 'correct' | 'forget') {
  await checkRenewalMemoryBoundary(change, 'last_scope_read');
}
it.each(['correct', 'forget'] as const)(
  'refuses turn renewal when %s is visible at the last scope-position read',
  refusesMemoryChangeAtScopeBoundary);

async function refusesTerminalMemoryDuringSigning(action: 'invalidated' | 'ended') {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const rows = await history(setup.nats.store, 'conversation-conversation', 'test');
  let prepared: z.infer<typeof memoryContextRecordedEventSchema> | undefined;
  for (const row of rows) {
    if (row.event.type !== 'agent.memory_context_recorded') continue;
    const recorded = memoryContextRecordedEventSchema.parse(row.event);
    if (recorded.data.action === 'prepared') prepared = recorded;
  }
  if (!prepared) throw new Error('Memory preparation missing from fixture');
  const reason = action === 'ended' ? 'ended' : 'access_changed';
  const terminal = { ...prepared.data, action, reason };
  const id = randomUUID();
  // Keep the server writer required by memory evidence.
  const terminalEvent = { ...prepared, id, commandId: id, data: terminal };
  memoryContextRecordedEventSchema.parse(terminalEvent);
  const bridge = await renewalBridge();
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function endDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    await setup.nats.seed([terminalEvent]);
    return result;
  }
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(endDuringSigning);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).toHaveBeenCalledOnce();
  } finally {
    issuance.mockRestore();
    await bridge.close();
  }
}
it.each(['invalidated', 'ended'] as const)(
  'refuses turn renewal when memory becomes %s during signing',
  refusesTerminalMemoryDuringSigning);

async function refusesRenewalAtOriginalDeadline() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  const confirm = decisionAccess.confirmDecisionAccess;
  let originalDeadline: number | undefined;
  async function captureDeadline(...args: Parameters<typeof confirm>) {
    originalDeadline ??= args[1].deadline;
    return confirm(...args);
  }
  const clock = vi.spyOn(performance, 'now');
  const issue = setup.tokens.turn.bind(setup.tokens);
  async function expireDuringSigning(input: Parameters<typeof issue>[0]) {
    const result = await issue(input);
    if (originalDeadline === undefined) throw new Error('Access check did not run');
    clock.mockReturnValue(originalDeadline);
    return result;
  }
  const access = vi.spyOn(decisionAccess, 'confirmDecisionAccess');
  access.mockImplementation(captureDeadline);
  const issuance = vi.spyOn(setup.tokens, 'turn');
  issuance.mockImplementationOnce(expireDuringSigning);
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
    access.mockRestore();
    issuance.mockRestore();
    await bridge.close();
  }
}
it('refuses turn renewal when signing reaches the original access deadline',
  refusesRenewalAtOriginalDeadline);

async function sanitisesMemoryPreparationError() {
  await seedRecallFact();
  expect((await directRecall('load')).statusCode).toBe(200);
  const bridge = await renewalBridge();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  async function* unavailableScope(...args: Parameters<typeof read>) {
    if (args[0] === `scope-${scopeId}`) throw new Error('Private canary in storage error');
    yield* read(...args);
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(unavailableScope);
  const issuance = vi.spyOn(setup.tokens, 'turn');
  try {
    const refused = { type: 'ack', sequence: 1, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(1)).toEqual(refused);
    expect(issuance).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    issuance.mockRestore();
    await bridge.close();
  }
}
it('returns only the fixed refusal when memory preparation fails', sanitisesMemoryPreparationError);

async function correctionAfterLoadedAppend() {
  await seedRecallFact();
  const initial = await directRecall('before-correction');
  expect(initial.statusCode, initial.body).toBe(200);
  const bridge = await renewalBridge();
  expect(await bridge.exchange(1)).toHaveProperty('token');
  const append = setup.nats.store.append.bind(setup.nats.store);
  let changed = false;
  async function correctAfterAppend(command: Parameters<typeof append>[0]) {
    const saved = await append(command);
    const parsed = memoryContextRecordedEventSchema.safeParse(command.event);
    if (parsed.success && parsed.data.data.action === 'loaded') {
      await changeLoadedMemory('correct');
      changed = true;
    }
    return saved;
  }
  const spy = vi.spyOn(setup.nats.store, 'append').mockImplementation(correctAfterAppend);
  try {
    const response = await directRecall('correct-after-load');
    expect(changed).toBe(true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
    const refused = { type: 'ack', sequence: 2, refused: 'memory_context_unavailable' };
    expect(await bridge.exchange(2)).toEqual(refused);
    expect(await bridge.exchange(2)).toEqual(refused);
    const decision = await setup.call();
    expect(decision.status).toBe(403);
    expect(decision.text).toContain('memory_context_unavailable');
    expect(setup.received()).toBe(0);
  } finally {
    spy.mockRestore();
    await bridge.close();
  }
}
it('withholds recall corrected after its loaded append and refuses renewal and decision',
  correctionAfterLoadedAppend);
