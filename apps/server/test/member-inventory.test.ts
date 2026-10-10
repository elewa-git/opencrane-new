import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversations, members, computers, pgDb, ProjectionRunner } from '@opencrane/projections';
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
async function append(subject: string, type: string, data: unknown, apply = true) {
  const record = { ...event(`inventory-${++counter}`, subject, type), silo: 'acme', data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}
async function project() {
  for (const projection of [members, conversations, computers]) await runner.run(projection);
}
function request(section: string, sub = 'owner', orgId = 'org-acme') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/members/bob/${section}`, headers });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('inventory-test'));
  for (const projection of [members, conversations, computers]) await runner.initialise(projection);
  for (const [memberId, role] of [['owner', 'owner'], ['admin', 'admin'], ['bob', 'member']]) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, email: `${memberId}@example.test`, displayName: memberId,
    });
  }
  await project();
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const memberReads = { silo: 'acme', store: nats.store, db, binding, feed: { memberId } };
  app = buildServer(config, { memberReads });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);

async function emptyReview() {
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ complete: true, unavailableSections: [],
    accessLost: [], ownedSharedWork: [], personalComputer: [],
    routines: { status: 'absent_on_version' },
    personalConnections: { status: 'absent_on_version' },
    retainedHistory: { count: 0, firstAt: null, lastAt: null }, permissions: { remove: false } });
  const before = await nats.store.head();
  expect((await request('access')).json()).toMatchObject({ complete: true, rows: [] });
  expect(await nats.store.head()).toBe(before);
}
it('distinguishes a checked empty inventory from version absences without saving events', emptyReview);

async function refusesReaders() {
  for (const section of ['access', 'departure']) {
    expect((await request(section, 'bob')).statusCode).toBe(403);
    expect((await request(section, 'owner', 'foreign')).statusCode).toBe(403);
    const spy = vi.spyOn(auth, 'check');
    const failure = { status: 'unavailable' as const, allowed: false as const,
      error: new Error('IAM unavailable') };
    spy.mockResolvedValueOnce(failure);
    expect((await request(section)).statusCode).toBe(503);
    spy.mockRestore();
  }
}
it('requires current Owner/Admin events and available OpenFGA despite an elevated cookie', refusesReaders);

async function recordsSources() {
  await append('assistant-personal', 'assistant.created', {
    assistantId: 'personal', kind: 'personal', ownerId: 'bob',
  });
  for (const teamId of ['sales', 'support']) {
    await append(`team-${teamId}`, 'team.created', { teamId, name: teamId, createdBy: 'bob' });
    await append(`team-${teamId}`, 'team.member_added', { teamId, memberId: 'bob', addedBy: 'owner' });
    await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'team',
      granteeId: teamId, grantedBy: 'owner',
    });
  }
  const direct = await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  await append(grantStream('mcp_tool', 'tool'), 'grant.given', {
    resourceType: 'mcp_tool', resourceId: 'tool', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  await project();
  const response = await request('access', 'admin');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ rows: [
    { resourceType: 'model', resourceId: 'gpt-6.1-sol', sources: [
      { kind: 'group', groupId: 'sales' }, { kind: 'group', groupId: 'support' },
      { kind: 'direct', eventId: direct.id }], eligibility: {
      person: 'allowed', assistants: [{ assistantId: 'personal', grant: 'denied' }] } },
    { resourceType: 'mcp_tool', eligibility: { availability: 'unavailable' } },
  ] });
  const assistantGrant = await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'assistant',
    granteeId: 'personal', grantedBy: 'owner',
  }, false);
  expect((await request('access')).json()).toMatchObject({ complete: false, rows: [
    { eligibility: { assistants: [{ assistantId: 'personal', grant: 'unavailable' }] } }, {}] });
  await auth.handler.handle(assistantGrant, pgDb(dbs.queue));
  expect((await request('access')).json()).toMatchObject({ rows: [
    { eligibility: { assistants: [{ assistantId: 'personal', grant: 'allowed' }] } }, {}] });
}
it('records direct and multiple group reasons and checks assistant grants separately', recordsSources);

async function retainsOnlyCounts() {
  const before = (await request('departure')).json<{ reviewRevision: string }>();
  await append('assistant-shared', 'assistant.created', {
    assistantId: 'shared', kind: 'team', ownerId: 'sales', name: 'Shared helper',
  });
  await append('conversation-private', 'conversation.created', {
    conversationId: 'private', assistantId: 'personal', createdBy: 'bob',
  });
  await append('conversation-private', 'message.posted', {
    conversationId: 'private', authorId: 'bob', authorKind: 'human',
    ciphertext: Buffer.from('PRIVATE CONTENT').toString('base64'),
    keyId: 'key:private', contentType: 'text',
  });
  await project();
  const spy = vi.spyOn(nats.store, 'readStream');
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ complete: true, ownedSharedWork: [],
    retainedHistory: { count: 1 } });
  expect(response.json<{ reviewRevision: string }>().reviewRevision).not.toBe(before.reviewRevision);
  expect(response.body).not.toMatch(/PRIVATE CONTENT|"private"|ciphertext|keyId|secretRef|tokenId/iu);
  for (const [subject] of spy.mock.calls) expect(subject).not.toMatch(/conversation|participation/iu);
  spy.mockRestore();
}
it('versions the full review and returns only private history counts and dates', retainsOnlyCounts);

async function blocksBehindProjection() {
  await append('computer-personal', 'computer.claimed', {
    assistantId: 'personal', computerId: 'pc', generation: 1, tokenId: 'token:PRIVATE_TOKEN',
  });
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ complete: false, permissions: { remove: false } });
  expect(response.body).not.toContain('token:PRIVATE_TOKEN');
  await project();
  const spy = vi.spyOn(nats.store, 'readStream');
  function unavailable(): never { throw new Error('SECRET FAILURE'); }
  spy.mockImplementationOnce(unavailable);
  expect((await request('departure')).statusCode).toBe(503);
  spy.mockRestore();
}
it('keeps a behind projection or failed reader distinct from an empty result', blocksBehindProjection);

async function blocksUnsupportedRecords() {
  const previous = (await request('departure')).json<{ reviewRevision: string }>();
  await append('member-bob', 'member.role_changed', {
    memberId: 'bob', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
  });
  await project();
  const changed = (await request('departure')).json<{ reviewRevision: string }>();
  expect(changed.reviewRevision).not.toBe(previous.reviewRevision);
  await append('assistant-unsupported', 'assistant.created', {
    assistantId: 'unsupported', kind: 'team', ownerId: 'bob',
  });
  await append('routine-old', 'routine.created', {
    routineId: 'old', assistantId: 'shared', schedule: 'daily', createdBy: 'bob',
  });
  await append('connection-old', 'connection.created', {
    userId: 'bob', serverId: 'server', profile: 'default', secretRef: 'secret:PRIVATE_KEY',
  });
  await project();
  const response = await request('departure');
  expect(response.json()).toMatchObject({ complete: false, permissions: { remove: false },
    routines: { status: 'unsupported_history' },
    personalConnections: { status: 'unsupported_history' } });
  const body = response.json<{ unavailableSections: string[] }>();
  expect(body.unavailableSections).toContain('unsupported_ownership');
  await append(grantStream('memory', 'PRIVATE_RESOURCE'), 'grant.given', {
    resourceType: 'memory', resourceId: 'PRIVATE_RESOURCE', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  const access = await request('access');
  expect(access.body).not.toContain('PRIVATE_RESOURCE');
  await append('member-admin', 'member.removed', { memberId: 'admin', removedBy: 'owner' });
  expect((await request('access', 'admin')).statusCode).toBe(403);
  expect((await request('departure', 'pending')).statusCode).toBe(403);
  expect(response.body).not.toContain('secret:PRIVATE_KEY');
}
it('versions member changes and blocks unsupported ownership, routines and connections', blocksUnsupportedRecords);
