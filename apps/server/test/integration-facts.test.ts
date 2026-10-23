import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import https from 'node:https';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { prepareGatewayConfiguration, publishToolPolicy, readToolPolicy,
  reviewToolPolicy } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { groups, members, modelAccess, mcpCatalogue, pgDb,
  ProjectionRunner } from '@opencrane/projections';
import { integrationFactsSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const logger = createLogger('facts-test', { level: 'silent' });
const projections = [members, groups, modelAccess, mcpCatalogue];
const subject = grantStream('mcp_server', 'fixture');
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let database: ReturnType<typeof pgDb>;
let runner: ProjectionRunner;
let counter = 0;
let logs = '';
function writeLog(line: string) {
  logs += line;
}
const logDestination = { write: writeLog };

async function append(stream: string, type: string, data: unknown, silo = 'acme', apply = true) {
  const record = { ...event(`facts-${++counter}`, stream, type), silo, data,
    time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'owner' } };
  const expectedSequence = await nats.store.head(stream);
  const command = { event: record, expectedSequence };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && silo === 'acme' && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, database);
  }
  return record;
}
async function project() {
  for (const projection of projections) {
    await runner.run(projection);
  }
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function joinAdmin() {
  await append('member-admin', 'member.joined', { memberId: 'admin', role: 'admin',
    email: 'admin@example.test', displayName: 'admin', invitationId: 'invite-admin' });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  database = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  runner = new ProjectionRunner(database, nats.reader, logger);
  for (const projection of projections) {
    await runner.initialise(projection);
  }
  await append('member-owner', 'member.joined', { memberId: 'owner', role: 'owner',
    email: 'owner@example.test', displayName: 'owner', invitationId: 'invite-owner' });
  await joinAdmin();
  for (const serverId of ['fixture', 'foreign']) {
    const silo = serverId === 'foreign' ? 'foreign' : 'acme';
    await append(`mcp-${serverId}`, 'mcp.server_registered', { serverId, kind: 'remote',
      locator: 'https://fixture.example.test/PRIVATE-CANARY', registeredBy: 'owner' }, silo);
  }
  await project();
  function unusedCatalogue(): never {
    throw new Error('Unexpected catalogue call');
  }
  const catalogue = { rows: unusedCatalogue, tools: unusedCatalogue };
  const integrations = { silo: 'acme', store: nats.store, modelDb: database,
    binding, feed: { memberId }, catalogue };
  vi.stubEnv('LOG_LEVEL', 'info');
  app = buildServer(config, { integrations, logDestination });
  vi.unstubAllEnvs();
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
function get(serverId = 'fixture', actor = 'owner') {
  const session = { sub: actor, orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ url: `/api/org/integrations/${serverId}/facts`, headers });
}
async function facts() {
  const response = await get();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toMatch(/PRIVATE-CANARY|definition|locator|displayName/u);
  return integrationFactsSchema.parse(response.json());
}
async function reviewedPublication() {
  const definition = '{"name":"read","description":"PRIVATE-CANARY","inputSchema":{"type":"object"}}';
  const revision = losslessJson(definition).digest;
  const tool = { name: 'read', definition, reviewed: false, costCents: 0, revision };
  const tools = [tool];
  const schemaDigest = catalogueDigest(tools);
  const captured = Date.now();
  await append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', toolCount: 1,
    connectionId: 'installed-fixture', accountMode: 'none', tools, schemaDigest,
    checkedAt: new Date(captured).toISOString(), expiresAt: new Date(captured + 300_000).toISOString() });
  const policy = await readToolPolicy(nats.store, 'acme', 'fixture');
  const review = { commandId: 'review', expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: schemaDigest,
    connectionId: 'installed-fixture', accountMode: 'none',
    tools: [{ name: 'read', revision: tool.revision, reviewDigest: toolReviewDigest(tool), mode: 'block' }] };
  expect((await reviewToolPolicy(nats.store, auth.binding, 'owner', 'fixture', review)).status)
    .toBe('appended');
  const reviewed = await readToolPolicy(nats.store, 'acme', 'fixture');
  await project();
  expect(await facts()).toMatchObject({ availability: { reviewRevision: reviewed.reviewRevision,
    publication: { status: 'disabled' } } });
  const publication = { commandId: 'publish', expectedSequence: reviewed.sequence,
    reviewRevision: reviewed.reviewRevision };
  expect((await publishToolPolicy(nats.store, auth.binding, 'owner', 'fixture', publication)).status)
    .toBe('appended');
  await project();
  expect(await facts()).toMatchObject({ connected: { status: 'no_account_required' },
    availability: { publication: { status: 'applying' } } });
  const record = await prepareGatewayConfiguration(nats.store, 'acme', 'fixture', 'publish');
  const observation = { generation: record.generation, recordDigest: record.recordDigest,
    configDigest: 'a'.repeat(64), processRef: '00000000-0000-4000-8000-000000000001',
    observedAt: new Date().toISOString() };
  await append('gateway-config-acme', 'gateway.configuration_observed',
    { ...observation, outcome: 'loaded' });
  await append('mcp-fixture', 'mcp.configuration_observed', { ...observation,
    serverId: 'fixture', changeRef: 'publish', fragmentDigest: record.members[0]!.fragmentDigest,
    sourceSequence: record.members[0]!.sourceSequence, reviewRevision: reviewed.reviewRevision });
  return { record, observation };
}

async function distinctSavedFacts() {
  expect(await facts()).toMatchObject({ installed: { status: 'registered' },
    connected: { status: 'unknown' }, allowedFor: { grantTotal: 0, complete: true },
    availability: { status: 'unavailable', reason: 'requester_assistant_required',
      publication: { status: 'disabled' } } });
  const { record, observation } = await reviewedPublication();
  const grant = await append(subject, 'grant.given', { resourceType: 'mcp_server',
    resourceId: 'fixture', granteeKind: 'member', granteeId: 'owner', grantedBy: 'owner' },
  'acme', false);
  expect(await facts()).toMatchObject({ allowedFor: { complete: false, grantTotal: null } });
  await project();
  expect(await facts()).toMatchObject({ allowedFor: { iam: 'applying', grantTotal: 1 },
    availability: { status: 'unavailable', policy: 'current', publication: { status: 'ready' } } });
  await auth.handler.handle(grant, database);
  const before = await facts();
  expect(before).toMatchObject({ allowedFor: { iam: 'current', complete: true },
    availability: { status: 'unavailable' } });
  const position = await nats.store.head();
  for (const projection of projections) {
    await runner.rebuild(projection);
  }
  const after = await facts();
  const comparison = { ...after, loadedAt: before.loadedAt };
  expect(comparison).toEqual(before);
  expect(after.loadedAt).not.toBe(before.loadedAt);
  expect(await nats.store.head()).toBe(position);
  await append('gateway-config-acme', 'gateway.configuration_observed',
    { ...observation, outcome: 'loaded', generation: record.generation + 1 });
  await project();
  expect(await facts()).toMatchObject({ availability: { publication: { status: 'applying' } } });
  await append('gateway-config-acme', 'gateway.configuration_observed',
    { ...observation, outcome: 'loaded' });
  await project();
}
it('separates real registration, review, publication and bounded grant receipts through replay',
  distinctSavedFacts, 120_000);

async function staleEvidence() {
  expect(await facts()).toMatchObject({ availability: { policy: 'current',
    publication: { status: 'ready' } } });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200_000);
  try {
    expect(await facts()).toMatchObject({ availability: { policy: 'unavailable',
      publication: { status: 'unknown' } } });
  } finally {
    clock.mockRestore();
  }
  await append('mcp-fixture', 'mcp.server_unpublished',
    { serverId: 'fixture', unpublishedBy: 'owner' });
  // Leave the catalogue projection behind the withdrawal deliberately.
  expect(await facts()).toMatchObject({ availability: { policy: 'unavailable',
    publication: { status: 'unknown' } } });
}
it('does not revive expired or withdrawn policy from old publication evidence', staleEvidence);

async function heldRead(change: string) {
  await joinAdmin();
  const query = database.query.bind(database);
  let held = false;
  database.query = async function hold(sql, parameters) {
    if (!held) {
      held = true;
      if (change === 'removed') {
        await append('member-admin', 'member.removed',
          { memberId: 'admin', removedBy: 'owner' }, 'acme', false);
      } else if (change === 'demoted') {
        await append('member-admin', 'member.role_changed',
          { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' }, 'acme', false);
      }
    }
    return query(sql, parameters);
  };
  try {
    const response = await get('fixture', 'admin');
    expect(held).toBe(true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    database.query = query;
    await joinAdmin();
  }
}
it.each(['removed', 'demoted'])('hides all facts when admin is %s during a held read', heldRead);

async function refusedAndSafe() {
  const missing = await get('missing');
  const foreign = await get('foreign');
  expect(missing.statusCode).toBe(404);
  expect(foreign.body).toBe(missing.body);
  const query = database.query.bind(database);
  database.query = function fail() {
    return Promise.reject(new Error('PRIVATE-CANARY'));
  };
  try {
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(logs).toContain('MCP catalogue unavailable');
    expect(logs).not.toContain('PRIVATE-CANARY');
  } finally {
    database.query = query;
  }
}
it('hides missing and foreign ids equally and sanitises failed reads', refusedAndSafe);

async function boundedGrants() {
  for (let index = 0; index < 101; index++) {
    await append(subject, 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind: 'member', granteeId: `old-${index}`, grantedBy: 'owner' }, 'acme', false);
  }
  await project();
  const response = await facts();
  expect(response.allowedFor).toMatchObject({ complete: false, grantTotal: null, iam: 'applying' });
  expect(response.allowedFor.grants).toHaveLength(100);
}
it('keeps overflowing saved grants incomplete without a guessed total', boundedGrants, 120_000);

async function boundedReadWithoutEffects() {
  const read = nats.store.readStream.bind(nats.store);
  const actualNow = performance.now.bind(performance);
  let offset = 0;
  let checks = 0;
  function now() {
    return actualNow() + offset;
  }
  function unexpected(): never {
    throw new Error('Unexpected effect');
  }
  async function* slow(stream: string, from?: number, deadline?: number) {
    expect(stream).not.toMatch(/conversation|participation|\*/u);
    if (stream === 'member-owner') {
      checks++;
      expect(offset).toBeGreaterThan(2000);
    }
    yield* read(stream, from, deadline);
    if (stream === 'mcp-fixture') {
      offset = 2500;
    }
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  const streams = vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const writes = vi.spyOn(nats.store, 'append').mockImplementation(unexpected);
  const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(unexpected);
  const requests = vi.spyOn(https, 'request').mockImplementation(unexpected);
  try {
    expect((await get()).statusCode).toBe(200);
    expect(checks).toBe(1);
    expect(writes).not.toHaveBeenCalled();
    expect(fetches).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    streams.mockRestore();
    writes.mockRestore();
    fetches.mockRestore();
    requests.mockRestore();
  }
}
it('loads history before one access check without writes or outside requests', boundedReadWithoutEffects);

async function accountVerificationUnavailable(accountMode: 'personal' | 'company') {
  const policy = await readToolPolicy(nats.store, 'acme', 'fixture');
  const snapshot = { ...policy.catalogue!, accountMode };
  await append('mcp-fixture', 'mcp.server_discovered', snapshot);
  const response = await facts();
  expect(response.connected).toMatchObject({ status: 'verification_unavailable', accountMode });
  expect(response.availability.status).toBe('unavailable');
  const extra = { ...response, locator: 'PRIVATE-CANARY' };
  expect(integrationFactsSchema.safeParse(extra).success).toBe(false);
}
it.each(['personal', 'company'] as const)('does not verify the %s account',
  accountVerificationUnavailable);

async function deadlineIsBounded() {
  const query = database.query.bind(database);
  const held = Promise.withResolvers<void>();
  database.query = async function hold(sql, parameters) {
    await held.promise;
    return query(sql, parameters);
  };
  try {
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } finally {
    database.query = query;
    held.resolve();
  }
}
it('ends a held content read at its own deadline', deadlineIsBounded, 20_000);
