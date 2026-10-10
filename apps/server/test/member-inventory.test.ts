import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversations, members, computers, pgDb, ProjectionRunner } from '@opencrane/projections';
import { memberAccessSchema, memberDepartureSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const unavailablePermission = { status: 'unavailable' as const, allowed: false as const,
  error: new Error('IAM unavailable') };
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
function request(section: string, sub = 'owner', orgId = 'org-acme', memberId = 'bob') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/members/${memberId}/${section}`, headers });
}
async function readInventory(section: string, memberId: string) {
  const response = await request(section, 'owner', 'org-acme', memberId);
  expect(response.statusCode).toBe(200);
  const body: unknown = response.json();
  if (section === 'departure') return memberDepartureSchema.parse(body);
  return memberAccessSchema.parse(body);
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
    retainedHistory: { count: 0, firstAt: null, lastAt: null }, permissions: { remove: true } });
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
    spy.mockResolvedValueOnce(unavailablePermission);
    expect((await request(section)).statusCode).toBe(503);
    spy.mockRestore();
  }
}
it('requires current Owner/Admin events and available OpenFGA despite an elevated cookie', refusesReaders);

async function waitsForGrantRevocation() {
  const memberId = 'revoked-grant';
  const resourceId = 'revoked-model';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'revoked@example.test', displayName: 'Revoked grant',
  });
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind: 'member',
    granteeId: memberId, grantedBy: 'owner',
  });
  await project();
  const initial = await readInventory('departure', memberId);
  expect(initial).toMatchObject({ complete: true, accessLost: [{ resourceId }] });

  const revocation = await append(grantStream('model', resourceId), 'grant.revoked', {
    resourceType: 'model', resourceId, granteeKind: 'member',
    granteeId: memberId, revokedBy: 'owner',
  }, false);
  await project();
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: true });
  for (const section of ['access', 'departure']) {
    const body = await readInventory(section, memberId);
    expect(body.complete).toBe(false);
    expect(body.unavailableSections).toContain('grants');
  }

  await auth.handler.handle(revocation, pgDb(dbs.queue));
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: false });
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: true, unavailableSections: [], rows: [] });
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: true, unavailableSections: [], accessLost: [] });
}
it('keeps both inventories incomplete until a grant revocation is applied', waitsForGrantRevocation);

async function waitsForGroupRemoval() {
  const memberId = 'removed-group';
  const teamId = 'last-group';
  const resourceId = 'group-model';
  const assistantId = 'last-group-helper';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'group@example.test', displayName: 'Removed group',
  });
  await append(`team-${teamId}`, 'team.created', {
    teamId, name: 'Last group', createdBy: 'owner',
  });
  await append(`team-${teamId}`, 'team.member_added', {
    teamId, memberId, addedBy: 'owner',
  });
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, kind: 'team', ownerId: teamId, name: 'Last group helper',
  });
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind: 'team',
    granteeId: teamId, grantedBy: 'owner',
  });
  await project();
  const initial = await readInventory('departure', memberId);
  expect(initial).toMatchObject({ complete: true, accessLost: [
    { resourceId }, { resourceId: assistantId },
  ] });

  const removal = await append(`team-${teamId}`, 'team.member_removed', {
    teamId, memberId, removedBy: 'owner',
  }, false);
  await project();
  expect(await auth.team(memberId, teamId)).toMatchObject({ allowed: true });
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: true });
  expect(await auth.actsFor(memberId, assistantId)).toMatchObject({ allowed: true });
  for (const section of ['access', 'departure']) {
    const body = await readInventory(section, memberId);
    expect(body.complete).toBe(false);
    expect(body.unavailableSections).toContain('group_membership');
  }

  await auth.handler.handle(removal, pgDb(dbs.queue));
  expect(await auth.team(memberId, teamId)).toMatchObject({ allowed: false });
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: true, unavailableSections: [], rows: [] });
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: true, unavailableSections: [], accessLost: [] });
}
it('keeps both inventories incomplete until the last group removal is applied', waitsForGroupRemoval);

async function waitsForSharedAssistantMembership() {
  const memberId = 'pending-group';
  const teamId = 'assistant-only-group';
  const assistantId = 'assistant-only-helper';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'pending@example.test', displayName: 'Pending group',
  });
  await append(`team-${teamId}`, 'team.created', {
    teamId, name: 'Assistant only', createdBy: 'owner',
  });
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, kind: 'team', ownerId: teamId, name: 'Shared helper',
  });
  const membership = await append(`team-${teamId}`, 'team.member_added', {
    teamId, memberId, addedBy: 'owner',
  }, false);
  await project();
  expect(await auth.actsFor(memberId, assistantId)).toMatchObject({ allowed: false });

  const pendingSelection = {
    resourceType: 'assistant', resourceId: assistantId, relation: 'acts_for',
    sources: [{ kind: 'group', groupId: teamId }],
    eligibility: { person: 'unavailable' },
  };
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: false, rows: [pendingSelection] });
  expect(access.unavailableSections).toContain('group_membership');
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: false, accessLost: [pendingSelection] });
  expect(departure.unavailableSections).toContain('group_membership');

  await auth.handler.handle(membership, pgDb(dbs.queue));
  const selectedAccess = await readInventory('access', memberId);
  expect(selectedAccess).toMatchObject({ rows: [
    { resourceId: assistantId, eligibility: { person: 'allowed' } },
  ] });
  expect(selectedAccess.unavailableSections).not.toContain('group_membership');
  const selectedDeparture = await readInventory('departure', memberId);
  expect(selectedDeparture).toMatchObject({ complete: true, unavailableSections: [], accessLost: [
    { resourceId: assistantId, eligibility: { person: 'allowed' } },
  ] });
}
it('waits for shared-assistant membership even without resource grants',
  waitsForSharedAssistantMembership);

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
  await project();
  const permission = vi.spyOn(auth, 'use');
  permission.mockResolvedValueOnce(unavailablePermission);
  expect((await request('departure')).json()).toMatchObject({ complete: false });
  permission.mockRestore();
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
