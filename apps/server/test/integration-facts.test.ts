import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { prepareGatewayConfiguration, publishToolPolicy, readToolPolicy,
  reviewToolPolicy } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { connectMcpCatalogue, groups, members, modelAccess, mcpCatalogue, pgDb,
  ProjectionRunner } from '@opencrane/projections';
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
  const catalogue = connectMcpCatalogue(database);
  const integrations = { silo: 'acme', store: nats.store, modelDb: database,
    binding, feed: { memberId }, catalogue };
  app = buildServer(config, { integrations });
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
  return response.json();
}
async function distinctSavedFacts() {
  expect(await facts()).toMatchObject({ installed: { status: 'registered' },
    connected: { status: 'unknown' }, allowedFor: { grantTotal: 0, complete: true },
    availability: { status: 'unavailable', reason: 'requester_assistant_required',
      publication: { status: 'disabled' } } });
  const definition = '{"name":"read","description":"PRIVATE-CANARY","inputSchema":{"type":"object"}}';
  const tool = { name: 'read', definition, revision: losslessJson(definition).digest };
  const tools = [tool];
  const schemaDigest = catalogueDigest(tools);
  await append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', toolCount: 1,
    connectionId: 'installed-fixture', accountMode: 'none', tools, schemaDigest,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const policy = await readToolPolicy(nats.store, 'acme', 'fixture');
  const review = { commandId: 'review', expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: schemaDigest,
    connectionId: 'installed-fixture', accountMode: 'none',
    tools: [{ name: 'read', revision: tool.revision, reviewDigest: toolReviewDigest(tool), mode: 'block' }] };
  expect((await reviewToolPolicy(nats.store, auth.binding, 'owner', 'fixture', review)).status)
    .toBe('appended');
  const reviewed = await readToolPolicy(nats.store, 'acme', 'fixture');
  const publication = { commandId: 'publish', expectedSequence: reviewed.sequence,
    reviewRevision: reviewed.reviewRevision };
  expect((await publishToolPolicy(nats.store, auth.binding, 'owner', 'fixture', publication)).status)
    .toBe('appended');
  await project();
  expect(await facts()).toMatchObject({ connected: { status: 'no_account_required' },
    availability: { publication: { status: 'applying' } } });
  const record = await prepareGatewayConfiguration(nats.store, 'acme', 'fixture', 'publish');
  const observation = { generation: record.generation, recordDigest: record.recordDigest,
    configDigest: 'a'.repeat(64), processRef: 'process', observedAt: new Date().toISOString() };
  await append('gateway-config-acme', 'gateway.configuration_observed', observation);
  await append('mcp-fixture', 'mcp.configuration_observed', { ...observation,
    serverId: 'fixture', changeRef: 'publish', fragmentDigest: record.members[0]!.fragmentDigest,
    sourceSequence: record.members[0]!.sourceSequence, reviewRevision: reviewed.reviewRevision });
  const grant = await append(subject, 'grant.given', { resourceType: 'mcp_server',
    resourceId: 'fixture', granteeKind: 'member', granteeId: 'owner', grantedBy: 'owner' },
  'acme', false);
  await project();
  expect(await facts()).toMatchObject({ allowedFor: { iam: 'applying', grantTotal: 1 },
    availability: { status: 'unavailable', publication: { status: 'ready' } } });
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
    { ...observation, generation: record.generation + 1 });
  await project();
  expect(await facts()).toMatchObject({ availability: { publication: { status: 'applying' } } });
}
it('separates real registration, review, publication and bounded grant receipts through replay',
  distinctSavedFacts, 120_000);

async function staleEvidence() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200_000);
  try {
    expect(await facts()).toMatchObject({ availability: { policy: 'unavailable' } });
  } finally {
    clock.mockRestore();
  }
  await append('mcp-fixture', 'mcp.server_unpublished',
    { serverId: 'fixture', unpublishedBy: 'owner' });
  // Leave the catalogue projection behind the withdrawal deliberately.
  expect(await facts()).toMatchObject({ availability: { policy: 'unavailable' } });
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
          { memberId: 'admin', role: 'member', changedBy: 'owner' }, 'acme', false);
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
  database.query = async function fail() {
    throw new Error('PRIVATE-CANARY');
  };
  try {
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
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
