import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import https from 'node:https';
import { z } from 'zod';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { history, readToolPolicy, reviewToolPolicy } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { mcpCatalogue, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let counter = 0;
let logs = '';
function writeLog(line: string) {
  logs += line;
}
const logDestination = { write: writeLog };
const definition = '{"name":"read","description":"PRIVATE-CANARY","inputSchema":{"type":"object"}}';
const revision = losslessJson(definition).digest;
const review = { action: 'Read a record', consequence: 'Return a record',
  targetArgument: 'id', fields: ['id'], stepUp: false };
const tool = { name: 'read', definition, revision, reviewed: false, costCents: 0, review };
const command = { commandId: 'original', expectedSequence: 0, connectionId: 'installed-fixture',
  toolName: 'read', toolRevision: revision, mode: 'allow' };

async function append(stream: string, type: string, data: unknown, apply = true) {
  const record = { ...event(`change-${++counter}`, stream, type), silo: 'acme', data,
    time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'owner' } };
  const saved = { event: record, expectedSequence: await nats.store.head(stream) };
  expect((await nats.store.append(saved)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}
async function join(memberId = 'admin', role = 'admin') {
  const data = { memberId, role, email: `${memberId}@example.test`, displayName: memberId,
    invitationId: `invite-${memberId}` };
  await append(`member-${memberId}`, 'member.joined', data);
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function unexpected(): never {
  throw new Error('Unexpected outside work');
}
async function initialise() {
  nats = await natsFixture();
  const info = await nats.connection.request('$JS.API.STREAM.INFO.EVENTS');
  const parsed = z.object({ config: z.record(z.string(), z.unknown()) }).parse(info.json());
  const updated = { ...parsed.config, duplicate_window: 100_000_000 };
  const bytes = new TextEncoder().encode(JSON.stringify(updated));
  const response = await nats.connection.request('$JS.API.STREAM.UPDATE.EVENTS', bytes);
  expect(z.object({ error: z.unknown().optional() }).parse(response.json()).error).toBeUndefined();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  await join('owner', 'owner');
  await join();
  const logger = createLogger('changes-test', { level: 'silent' });
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader, logger);
  await runner.initialise(mcpCatalogue);
  const catalogue = { rows: unexpected, tools: unexpected };
  const integrations = { silo: 'acme', store: nats.store, binding, feed: { memberId }, catalogue };
  vi.stubEnv('LOG_LEVEL', 'info');
  const options = { integrations, logDestination };
  app = buildServer(config, options);
  vi.unstubAllEnvs();
  const registration = { serverId: 'fixture', kind: 'remote',
    locator: 'https://fixture.example.test/PRIVATE-CANARY', registeredBy: 'owner' };
  await append('mcp-fixture', 'mcp.server_registered', registration);
  await discover(tool);
  const policy = await readToolPolicy(nats.store, 'acme', 'fixture');
  const choice = { name: 'read', revision, reviewDigest: toolReviewDigest(tool), mode: 'block' };
  const input = { commandId: 'review', expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: policy.catalogue!.schemaDigest,
    connectionId: command.connectionId, accountMode: 'none', tools: [choice] };
  expect((await reviewToolPolicy(nats.store, binding, 'admin', 'fixture', input)).status)
    .toBe('appended');
  command.expectedSequence = await nats.store.head('mcp-fixture');
}
async function discover(declaration: typeof tool) {
  const captured = Date.now();
  const tools = [declaration];
  const data = { serverId: 'fixture', toolCount: 1, connectionId: command.connectionId,
    accountMode: 'none', tools, schemaDigest: catalogueDigest(tools),
    checkedAt: new Date(captured).toISOString(), expiresAt: new Date(captured + 300_000).toISOString() };
  await append('mcp-fixture', 'mcp.server_discovered', data);
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
function headers(actor = 'admin', orgId = 'org-acme') {
  const session = { sub: actor, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
}
function get(changeRef = 'original', serverId = 'fixture', actor = 'admin', orgId = 'org-acme') {
  const url = `/api/org/integrations/${serverId}/changes/${changeRef}`;
  const request = { url, headers: headers(actor, orgId) };
  return app.inject(request);
}
function post(payload = command, actor = 'admin') {
  const request = { method: 'POST' as const, url: '/api/org/integrations/fixture/tools',
    headers: headers(actor), payload };
  return app.inject(request);
}
async function recoversOriginal() {
  const appendEvent = nats.store.append.bind(nats.store);
  async function loseReply(input: Parameters<typeof appendEvent>[0]): Promise<never> {
    await appendEvent(input);
    throw new Error('PRIVATE-CANARY');
  }
  const lost = vi.spyOn(nats.store, 'append').mockImplementation(loseReply);
  try {
    expect((await post()).statusCode).toBe(503);
  } finally {
    lost.mockRestore();
  }
  const original = await nats.store.readEvent(await nats.store.head('mcp-fixture'));
  expect(original.event.type).toBe('mcp.tool_mode_set');
  await readToolPolicy(nats.store, 'acme', 'fixture');
  const receipt = { changeRef: 'original', eventId: original.event.id,
    recordedAt: original.event.time, sequence: original.sequence, serverId: 'fixture',
    connectionId: command.connectionId, toolRevision: revision, mode: 'allow', setBy: 'admin' };
  const next = { ...command, commandId: 'later', expectedSequence: original.sequence, mode: 'block' };
  const later = await post(next);
  expect(later.statusCode).toBe(200);
  expect(later.json()).toMatchObject({ receipt: { changeRef: 'later', mode: 'block' } });
  const changedDefinition = definition.replace('PRIVATE-CANARY', 'PRIVATE-CANARY-CHANGED');
  const changed = { ...tool, definition: changedDefinition,
    revision: losslessJson(changedDefinition).digest };
  await discover(changed);
  await delay(150);
  const before = await nats.store.head();
  const recovered = await get();
  expect(recovered.statusCode).toBe(200);
  expect(recovered.headers['cache-control']).toBe('no-store');
  expect(recovered.json()).toEqual({ status: 'appended', receipt, availability: {
    status: 'unavailable', reason: 'requester_assistant_required', policy: 'unavailable',
    sequence: before } });
  const retried = await post();
  expect(retried.statusCode).toBe(200);
  expect(retried.json()).toMatchObject({ receipt, policy: { tools: [{ mode: 'block' }] } });
  await runner.rebuild(mcpCatalogue);
  expect((await get()).json()).toEqual(recovered.json());
  expect(await nats.store.head()).toBe(before);
  const changedMode = { ...command, mode: 'ask' };
  expect((await post(changedMode)).statusCode).toBe(409);
  expect((await post(command, 'owner')).statusCode).toBe(409);
  const changedPosition = { ...command, expectedSequence: before };
  expect((await post(changedPosition)).statusCode).toBe(409);
  const stale = { ...command, commandId: 'stale', expectedSequence: before };
  expect((await post(stale)).statusCode).toBe(409);
  expect((await get('stale')).json()).toEqual({ status: 'unknown' });
  const retriedReceipt = retried.json<{ receipt: unknown }>().receipt;
  expect(recovered.body + JSON.stringify(retriedReceipt) + logs).not.toContain('PRIVATE-CANARY');
}
it('recovers a lost save after mode and catalogue changes, dedup expiry and replay', recoversOriginal);

async function reviewCommand(commandId: string) {
  const policy = await readToolPolicy(nats.store, 'acme', 'fixture');
  const choice = { name: 'read', revision: policy.tools[0]!.revision,
    reviewDigest: toolReviewDigest(policy.catalogue!.tools![0]!), mode: 'block' };
  return { commandId, expectedSequence: policy.sequence, policyRevision: policy.policyRevision,
    catalogueDigest: policy.catalogue!.schemaDigest, connectionId: command.connectionId,
    accountMode: 'none', tools: [choice] };
}
function postReview(payload: Awaited<ReturnType<typeof reviewCommand>>, actor = 'admin') {
  const request = { method: 'POST' as const, url: '/api/org/integrations/fixture/review',
    headers: headers(actor), payload };
  return app.inject(request);
}
async function recoversOriginalReview() {
  await discover(tool);
  const input = await reviewCommand('review-original');
  const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
    granteeKind: 'member', granteeId: 'admin', grantedBy: 'owner' };
  await append('grant-mcp_server-fixture', 'grant.given', grant, false);
  const appendEvent = nats.store.append.bind(nats.store);
  async function loseReply(input: Parameters<typeof appendEvent>[0]): Promise<never> {
    await appendEvent(input);
    throw new Error('PRIVATE-CANARY');
  }
  const lost = vi.spyOn(nats.store, 'append').mockImplementation(loseReply);
  try {
    expect((await postReview(input)).statusCode).toBe(503);
  } finally {
    lost.mockRestore();
  }
  const original = await nats.store.readEvent(await nats.store.head('mcp-fixture'));
  expect(original.event.type).toBe('mcp.server_reviewed');
  expect(original.sequence).toBeGreaterThan(input.expectedSequence + 1);
  const receipt = { changeRef: input.commandId, eventId: original.event.id,
    recordedAt: original.event.time, sequence: original.sequence, serverId: 'fixture',
    connectionId: input.connectionId, catalogueDigest: input.catalogueDigest,
    policyRevision: input.policyRevision, reviewRevision: original.sequence, reviewedBy: 'admin' };
  const changedDefinition = definition.replace('PRIVATE-CANARY', 'PRIVATE-CANARY-NEW-REVIEW');
  const changed = { ...tool, definition: changedDefinition,
    revision: losslessJson(changedDefinition).digest };
  await discover(changed);
  const laterInput = await reviewCommand('review-later');
  await append('grant-mcp_server-fixture', 'grant.given', grant, false);
  const later = await postReview(laterInput);
  expect(later.statusCode).toBe(200);
  expect(later.json()).toMatchObject({ status: 'appended', receipt: {
    changeRef: 'review-later', catalogueDigest: laterInput.catalogueDigest } });
  const laterSequence = await nats.store.head('mcp-fixture');
  expect(later.json()).toMatchObject({ sequence: laterSequence,
    receipt: { sequence: laterSequence, reviewRevision: laterSequence } });
  expect(laterSequence).toBeGreaterThan(laterInput.expectedSequence + 1);
  await delay(150);
  await app.close();
  const catalogue = { rows: unexpected, tools: unexpected };
  const integrations = { silo: 'acme', store: nats.store, binding: auth.binding,
    feed: { memberId }, catalogue };
  app = buildServer(config, { integrations, logDestination });
  await runner.rebuild(mcpCatalogue);
  const before = await nats.store.head();
  const recovered = await get(input.commandId);
  expect(recovered.statusCode).toBe(200);
  expect(recovered.headers['cache-control']).toBe('no-store');
  expect(recovered.json()).toEqual({ status: 'appended', receipt, availability: {
    status: 'unavailable', reason: 'requester_assistant_required', policy: 'unavailable',
    sequence: laterSequence } });
  const retried = await postReview(input);
  expect(retried.statusCode).toBe(200);
  expect(retried.json()).toEqual({ status: 'appended', sequence: original.sequence, receipt });
  const changedPayload = { ...input, catalogueDigest: 'f'.repeat(64) };
  expect((await postReview(changedPayload)).statusCode).toBe(409);
  expect((await postReview(input, 'owner')).statusCode).toBe(409);
  const changedPosition = { ...input, expectedSequence: before };
  expect((await postReview(changedPosition)).statusCode).toBe(409);
  const stale = { ...input, commandId: 'review-stale', expectedSequence: laterSequence };
  expect((await postReview(stale)).statusCode).toBe(409);
  expect((await get(stale.commandId)).json()).toEqual({ status: 'unknown' });
  expect(await nats.store.head()).toBe(before);
  expect(recovered.body + retried.body + later.body + logs).not.toContain('PRIVATE-CANARY');
}
it('recovers the first review after a lost reply, later review, restart and replay',
  recoversOriginalReview);

async function rejectsForgedReviews() {
  const rows = await history(nats.store, 'mcp-fixture', 'acme');
  function isReview(row: typeof rows[number]) {
    return row.event.id === 'review-original';
  }
  const saved = rows.find(isReview)!;
  const originalData = saved.event.data as Record<string, unknown>;
  const patches = [{ subject: 'mcp-other' }, { silo: 'other' }, { id: 'different' },
    { commandId: 'different' }, { type: 'mcp.server_published' }, { source: 'untrusted' },
    { principal: { kind: 'system' as const, id: 'admin' } },
    { principal: { kind: 'human' as const, id: 'owner' } },
    { data: { ...originalData, reviewedBy: 'owner' } },
    { data: { ...originalData, serverId: 'other' } },
    { data: { ...originalData, catalogueDigest: 'invalid' } }];
  for (const patch of patches) {
    const substituted = { ...saved, event: { ...saved.event, ...patch } };
    const originalRead = nats.store.readStream.bind(nats.store);
    async function* replace(stream: string, from?: number, deadline?: number) {
      if (stream === 'mcp-fixture') {
        yield substituted;
        return;
      }
      yield* originalRead(stream, from, deadline);
    }
    const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
    try {
      expect((await get('review-original')).json()).toEqual({ status: 'unknown' });
    } finally {
      spy.mockRestore();
    }
  }
  expect((await get('review-original', 'other')).json()).toEqual({ status: 'unknown' });
}
it('does not confirm a review from a different operation, stream, source or actor',
  rejectsForgedReviews);

async function rejectsUnrelatedReferences() {
  for (const [reference, server, actor, org] of [
    ['missing', 'fixture', 'admin', 'org-acme'], ['review-original', 'fixture', 'owner', 'org-acme'],
    ['original', 'other', 'admin', 'org-acme'], ['original', 'fixture', 'owner', 'org-acme'],
  ]) {
    const response = await get(reference, server, actor, org);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'unknown' });
  }
  expect((await get('original', 'fixture', 'admin', 'other')).statusCode).toBe(403);
  const rows = await history(nats.store, 'mcp-fixture', 'acme');
  const saved = rows.find(isOriginal)!;
  for (const patch of [{ subject: 'mcp-other' }, { silo: 'other' },
    { principal: { kind: 'system' as const, id: 'admin' } }, { id: 'different' },
    { source: 'untrusted' }, { commandId: 'different' },
    { data: { serverId: 'fixture', connectionId: command.connectionId, toolName: 'read',
      toolRevision: revision, mode: 'allow', setBy: 'owner' } }]) {
    const substituted = { ...saved, event: { ...saved.event, ...patch } };
    const originalRead = nats.store.readStream.bind(nats.store);
    async function* replace(stream: string, from?: number, deadline?: number) {
      if (stream === 'mcp-fixture') {
        yield substituted;
        return;
      }
      yield* originalRead(stream, from, deadline);
    }
    const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(replace);
    try {
      expect((await get()).json()).toEqual({ status: 'unknown' });
    } finally {
      spy.mockRestore();
    }
  }
}
function isOriginal(row: Awaited<ReturnType<typeof history>>[number]) {
  return row.event.commandId === 'original';
}
it('never confirms missing, wrong-operation, foreign or unverified references', rejectsUnrelatedReferences);

async function accessAfterLoading(change: string, failed: boolean, reference: string) {
  await join();
  const read = nats.store.readStream.bind(nats.store);
  let checks = 0;
  let pending: Awaited<ReturnType<typeof append>> | undefined;
  let appendingChange = false;
  async function* intercepted(stream: string, from?: number, deadline?: number) {
    if (stream === 'member-admin' && !appendingChange) {
      checks++;
    }
    if (stream === 'mcp-fixture') {
      expect(checks).toBe(0);
      appendingChange = true;
      if (change === 'removed') {
        const data = { memberId: 'admin', removedBy: 'owner' };
        pending = await append('member-admin', 'member.removed', data, false);
      } else if (change === 'demoted') {
        const data = { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
        pending = await append('member-admin', 'member.role_changed', data, false);
      }
      appendingChange = false;
      if (failed) {
        throw new Error('PRIVATE-CANARY');
      }
    }
    yield* read(stream, from, deadline);
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(intercepted);
  const permission = vi.spyOn(auth, 'check');
  if (change === 'outage') {
    const unavailable = { allowed: false as const, status: 'unavailable' as const,
      error: new Error('PRIVATE-CANARY') };
    permission.mockResolvedValue(unavailable);
  }
  try {
    const response = await get(reference);
    expect(response.statusCode).toBe(change === 'outage' || change === 'unchanged' ? 503 : 403);
    expect(checks).toBe(1);
    expect(response.body + logs).not.toContain('PRIVATE-CANARY');
  } finally {
    spy.mockRestore();
    permission.mockRestore();
    if (pending) {
      await auth.handler.handle(pending, pgDb(dbs.queue));
    }
    await join();
  }
}
async function successfulLoading(change: string) {
  for (const reference of ['original', 'review-original']) {
    await accessAfterLoading(change, false, reference);
  }
}
async function failedLoading(change: string) {
  for (const reference of ['original', 'review-original']) {
    await accessAfterLoading(change, true, reference);
  }
}
it.each(['removed', 'demoted', 'outage'])('checks %s access after successful loading',
  successfulLoading);
it.each(['removed', 'demoted', 'outage', 'unchanged'])('checks %s access after failed loading',
  failedLoading);

async function readsWithoutEffects() {
  const read = nats.store.readStream.bind(nats.store);
  const realNow = performance.now.bind(performance);
  let offset = 0;
  let checks = 0;
  function now() {
    return realNow() + offset;
  }
  async function* slow(stream: string, from?: number, deadline?: number) {
    expect(stream).not.toMatch(/conversation|participation|\*/u);
    if (stream === 'member-admin') {
      checks++;
      expect(offset).toBe(2500);
    }
    yield* read(stream, from, deadline);
    if (stream === 'mcp-fixture') {
      offset = 2500;
    }
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  const streams = vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const writes = vi.spyOn(nats.store, 'append').mockImplementation(unexpected);
  const positions = vi.spyOn(nats.store, 'head').mockImplementation(unexpected);
  const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(unexpected);
  const requests = vi.spyOn(https, 'request').mockImplementation(unexpected);
  try {
    for (const reference of ['original', 'review-original']) {
      offset = 0;
      checks = 0;
      const response = await get(reference);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'appended' });
      expect(checks).toBe(1);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    expect(fetches).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    streams.mockRestore();
    writes.mockRestore();
    positions.mockRestore();
    fetches.mockRestore();
    requests.mockRestore();
  }
}
it('loads slow history before one access check and performs no outside work', readsWithoutEffects);

async function refusesExpiredHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const realNow = performance.now.bind(performance);
  let offset = 0;
  let checks = 0;
  function now() {
    return realNow() + offset;
  }
  async function* expired(stream: string, from?: number, deadline?: number) {
    if (stream === 'member-admin') {
      checks++;
      expect(offset).toBe(10_001);
    }
    if (stream === 'mcp-fixture') {
      expect(deadline).toBeGreaterThan(realNow());
      expect(deadline).toBeLessThanOrEqual(realNow() + 10_000);
    }
    yield* read(stream, from, deadline);
    if (stream === 'mcp-fixture') {
      offset = 10_001;
    }
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  const streams = vi.spyOn(nats.store, 'readStream').mockImplementation(expired);
  try {
    const response = await get('review-original');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(checks).toBe(1);
  } finally {
    clock.mockRestore();
    streams.mockRestore();
  }
}
it('limits review history loading and still checks access after expiry', refusesExpiredHistory);
