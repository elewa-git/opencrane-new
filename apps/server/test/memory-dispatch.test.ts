import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { history, ingestUsage, parseMemoryRequest, readToolPolicy } from '@opencrane/models';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
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
  await app?.close();
  await setup?.close();
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
async function directRecall(callId: string) {
  const body = recallCall(callId);
  const token = await signedRecall(setup, {}, body);
  const requestHeaders = { ...headers, 'x-memory-context': token };
  const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: body };
  return app.inject(request);
}
async function savedContext() {
  return readChatFacts(setup.nats.store, 'test', 'conversation', 'turn');
}
async function seedRecallFact() {
  const keys = memoryKeys(dirname(setup.options.configFile));
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId: 'private-fact', revision: 1 };
  keys.provision(identity);
  const data = { ...identity, schemaVersion: 1, kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [], ...keys.encrypt(identity, 'Private canary') };
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

async function refusesStoppedRootMemory() {
  const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
    threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
    payingGroupId: 'personal-default', allowanceCents: 1000 };
  const root = await setup.actor.setRootAllowance(binding, 1);
  const permit = await memoryPass(call, 'recall');
  const subject = 'conversation-conversation';
  const payload = { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' };
  await setup.append(subject, 'agent.turn_stop_requested', payload);
  const position = await setup.nats.store.head(subject);
  await setup.actor.stopRoot(root.rootId, 'requester_stop', subject, position);
  const before = await setup.nats.store.head();
  const beforeRequests = backendRequests;
  expect((await dispatchMemory(permit, call)).status).toBe(403);
  expect(backendRequests).toBe(beforeRequests);
  expect(await setup.nats.store.head()).toBe(before);
  const response = await setup.call(headers, call, route);
  expect(response.status).toBe(403);
  expect(backendRequests).toBe(beforeRequests);
}
it('refuses an old memory permit and a new grant after its root stops', refusesStoppedRootMemory);

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
