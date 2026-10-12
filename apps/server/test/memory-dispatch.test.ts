import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '@opencrane/models/testing';
import { parseMemoryRequest, readToolPolicy } from '@opencrane/models';
import { memoryKeys, memoryProjection, memoryScopeId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
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
  await setup.call(headers, call, route);
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
beforeAll(prepare, 120_000);
beforeEach(renewCredentials);
afterAll(close);

async function memoryBinding(target: typeof setup) {
  const policy = await readToolPolicy(target.nats.store, 'test', 'memory');
  const bytes = randomBytes(32);
  return { permitDigest: bytes.toString('hex'), backendGeneration: 'memory-instance',
    schemaDigest: memoryCatalogue.schemaDigest, policyRevision: policy.policyRevision };
}
async function signedRecall(target: typeof setup, overrides = {}) {
  const parsed = parseMemoryRequest(JSON.stringify(call), headers);
  const dispatch = await memoryBinding(target);
  const claims = { silo: 'test', requester: 'alice', assistant: 'assistant',
    computer: 'computer', generation: 1, conversation: 'conversation', turn: 'turn',
    thread: 'thread', operation: 'recall', scopes: [scopeId], contentAccess: 'private',
    bodyDigest: parsed.bodyDigest, callId: metadata.callId, dispatch,
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
        const expiresAt = new Date(Date.now() + 300_000).toISOString();
        const check = { serverId: 'memory', outcome, checkedAt, expiresAt,
          schemaDigest: memoryCatalogue.schemaDigest };
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
  } finally {
    delayed.mockRestore();
    if (generation === undefined) {
      delete configured.generation;
    } else {
      configured.generation = generation;
    }
    await govern(setup);
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
    dispatchGeneration: 'memory-instance' };
  const restarted = buildServer(testAuthConfig(), { memory });
  try {
    const requestHeaders = { ...headers, 'x-memory-context': captured };
    const request = { method: 'POST' as const, url: route, headers: requestHeaders, payload: call };
    const response = await restarted.inject(request);
    expect(response.statusCode).toBe(403);
    const fresh = await signedRecall(setup);
    const freshHeaders = { ...headers, 'x-memory-context': fresh };
    const freshRequest = { ...request, headers: freshHeaders };
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
  const passes = await Promise.all([memoryPass(call, 'recall'), memoryPass(call, 'recall')]);
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
    const replies = await Promise.all([dispatchMemory(first, call), dispatchMemory(second, call)]);
    for (const reply of replies) {
      expect(reply.status, await reply.text()).toBe(200);
    }
    expect(admissions).toBe(3);
    expect(backendRequests).toBe(before + 2);
  } finally {
    bothReady.resolve();
    delayed.mockRestore();
  }
}
it('admits two concurrent memory calls on the same tool', allowsConcurrentMemory);
