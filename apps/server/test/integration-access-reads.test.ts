import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { grantRevokedDataSchema, type EventEnvelope } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { MemberAccessRefused, readActiveMember } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { groups, members, modelAccess, pgDb, ProjectionRunner,
  rebuildModelAccessProjection, rebuildMemberProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const path = '/api/org/integrations/fixture/access';
const subject = grantStream('mcp_server', 'fixture');
const logger = createLogger('access-reads-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let database: ReturnType<typeof pgDb>;
let runner: ProjectionRunner;
let counter = 0;

async function append(stream: string, type: string, data: unknown, silo = 'acme', apply = true) {
  const record = { ...event(`read-fixture-${++counter}`, stream, type), silo, data };
  const expectedSequence = await nats.store.head(stream);
  const command = { event: record, expectedSequence };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && silo === 'acme' && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, database);
  }
  return record;
}

async function project() {
  for (const projection of [members, groups, modelAccess]) await runner.run(projection);
}

function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  database = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  runner = new ProjectionRunner(database, nats.reader, logger);
  for (const projection of [members, groups, modelAccess]) await runner.initialise(projection);
  for (const [id, role] of [['owner', 'owner'], ['admin', 'admin'], ['bob', 'member']]) {
    await append(`member-${id}`, 'member.joined', { memberId: id, role,
      email: `${id}@example.test`, displayName: id, invitationId: `invite-${id}` });
  }
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'bob', addedBy: 'owner',
  });
  await append('assistant-helper', 'assistant.created', {
    assistantId: 'helper', kind: 'personal', ownerId: 'bob',
  });
  for (const silo of ['acme', 'foreign']) {
    const serverId = silo === 'acme' ? 'fixture' : 'foreign';
    await append(`mcp-${serverId}`, 'mcp.server_registered', { serverId, kind: 'remote',
      locator: 'https://fixture.example.test/private-canary', registeredBy: 'owner' }, silo);
  }
  await append('member-stranger', 'member.joined', { memberId: 'stranger', role: 'member',
    email: 'stranger@example.test', displayName: 'Foreign canary', invitationId: 'foreign' },
  'foreign');
  for (const [granteeKind, granteeId] of [['member', 'bob'], ['team', 'sales'],
    ['assistant', 'helper']]) {
    await append(subject, 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind, granteeId, grantedBy: 'owner' });
  }
  await project();
  const options = { silo: 'acme', store: nats.store, db: database, binding, feed: { memberId } };
  app = buildServer(config, { modelAccess: options });
}

async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

function get(url = path, actor = 'owner') {
  const session = { sub: actor, orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const request = { method: 'GET' as const, url, headers };
  return app.inject(request);
}

async function readsSourcesAndCandidates() {
  const position = await nats.store.head();
  const read = nats.store.readStream.bind(nats.store);
  nats.store.readStream = async function* bounded(stream, from, deadline) {
    expect(stream).not.toMatch(/\*|conversation|participation/u);
    yield* read(stream, from, deadline);
  };
  try {
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ serverId: 'fixture', complete: true, grantTotal: 3,
      expectedSequence: await nats.store.head(subject), projection: { content: 'current', iam: 'current' },
      grants: [
        { source: 'assistant', displayName: 'bob personal assistant', state: 'granted' },
        { source: 'direct', displayName: 'bob', state: 'granted' },
        { source: 'group', displayName: 'Sales', state: 'granted' },
      ] });
    expect(response.body).not.toMatch(/private-canary|Foreign canary|availability/u);
    const membersPage = await get(`${path}/candidates?kind=member&limit=1`, 'admin');
    expect(membersPage.json()).toMatchObject({ rows: [{ id: 'admin' }], next: 'admin' });
    const nextPage = await get(`${path}/candidates?kind=member&limit=100&after=admin`);
    expect(nextPage.json()).toMatchObject({ rows: [{ id: 'bob' }, { id: 'owner' }], next: null });
    const teams = await get(`${path}/candidates?kind=team`);
    expect(teams.json()).toMatchObject({ rows: [{ id: 'sales', memberCount: 1 }], next: null });
    const assistants = await get(`${path}/candidates?kind=assistant`);
    expect(assistants.json()).toMatchObject({ rows: [{ id: 'helper', displayName: 'bob personal assistant' }] });
    expect(await nats.store.head()).toBe(position);
  } finally {
    nats.store.readStream = read;
  }
}
it('reads named sources and bounded choices without wildcard history or writes', readsSourcesAndCandidates);

async function refusesInvalidReads() {
  for (const suffix of ['', '/candidates?kind=member']) {
    for (const actor of ['bob', 'stranger', 'missing']) {
      const response = await get(`${path}${suffix}`, actor);
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const id of ['foreign', 'missing']) {
      expect((await get(`${path.replace('fixture', id)}${suffix}`)).statusCode).toBe(404);
    }
  }
  for (const query of ['kind=member&limit=0', 'kind=member&limit=101', 'kind=member&limit=1.5',
    'kind=member&limit=9007199254740992', 'kind=member&after=bad!', 'kind=unknown',
    'kind=member&unexpected=value']) {
    expect((await get(`${path}/candidates?${query}`)).statusCode).toBe(400);
  }
  expect((await get(`${path}?unexpected=value`)).statusCode).toBe(400);
}
it('refuses outsiders, foreign and unknown servers and invalid page inputs', refusesInvalidReads);

async function labelsDepartedGrantHolderAfterReplay() {
  const grant = await append(subject, 'grant.given', { resourceType: 'mcp_server',
    resourceId: 'fixture', granteeId: 'bob', granteeKind: 'member', grantedBy: 'owner' });
  await append('member-bob', 'member.removed', { memberId: 'bob', removedBy: 'owner' });
  await project();
  try {
    const before = await get();
    expect(before.statusCode, before.body).toBe(200);
    const expected = { complete: true, grantTotal: 3, grants: [
      { granteeKind: 'assistant', granteeId: 'helper' },
      { granteeKind: 'member', granteeId: 'bob', displayName: 'bob',
        state: 'granted', membershipStatus: 'departed', eventId: grant.id },
      { granteeKind: 'team', granteeId: 'sales' },
    ] };
    expect(before.json()).toMatchObject(expected);
    const choices = await get(`${path}/candidates?kind=member`);
    expect(choices.json()).toMatchObject({ rows: [{ id: 'admin' }, { id: 'owner' }] });
    const teams = await get(`${path}/candidates?kind=team`);
    expect(teams.json()).toMatchObject({ rows: [{ id: 'sales', memberCount: 0 }] });
    expect((await auth.check('bob', 'member')).allowed).toBe(false);
    await expect(readActiveMember(nats.store, auth.binding, 'bob'))
      .rejects.toThrow(MemberAccessRefused);
    const position = await nats.store.head();
    await rebuildModelAccessProjection(database, nats.reader, logger, { verify: true });
    await rebuildMemberProjection(database, nats.reader, logger, { verify: true });
    const after = await get();
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toMatchObject(expected);
    const original = before.json<{ loadedAt: string }>();
    const replayed = after.json<{ loadedAt: string }>();
    const replayComparison = { ...replayed, loadedAt: original.loadedAt };
    expect(replayComparison).toEqual(original);
    expect((await auth.check('bob', 'member')).allowed).toBe(false);
    await expect(readActiveMember(nats.store, auth.binding, 'bob'))
      .rejects.toThrow(MemberAccessRefused);
    expect(await nats.store.head()).toBe(position);
  } finally {
    await append('member-bob', 'member.joined', { memberId: 'bob', role: 'member',
      email: 'bob@example.test', displayName: 'bob', invitationId: 'invite-bob' });
    await project();
  }
}
it('labels Bob departed while keeping his saved grant before and after replay',
  labelsDepartedGrantHolderAfterReplay, 120_000);

async function reportsLagAndReplays() {
  const revoke = await append(subject, 'grant.revoked', { resourceType: 'mcp_server',
    resourceId: 'fixture', granteeId: 'bob', granteeKind: 'member', revokedBy: 'owner' }, 'acme', false);
  const lagging = await get();
  expect(lagging.json()).toMatchObject({ complete: false, grantTotal: null,
    projection: { content: 'applying', iam: 'applying' } });
  await project();
  const pending = await get();
  expect(pending.json()).toMatchObject({ projection: { content: 'current', iam: 'applying' },
  });
  const pendingGrants = pending.json<{ grants: unknown[] }>().grants;
  expect(pendingGrants[1]).toMatchObject({ state: 'revoked', eventId: revoke.id });
  await auth.handler.handle(revoke, database);
  await append('member-bob', 'member.removed', { memberId: 'bob', removedBy: 'owner' });
  await project();
  const before = await get();
  const page = await get(`${path}/candidates?kind=member`);
  expect(page.json()).toMatchObject({ rows: [{ id: 'admin' }, { id: 'owner' }] });
  const position = await nats.store.head();
  await rebuildModelAccessProjection(database, nats.reader, logger, { verify: true });
  await rebuildMemberProjection(database, nats.reader, logger, { verify: true });
  const after = await get();
  const original = before.json<{ loadedAt: string }>();
  const replayed = after.json<{ loadedAt: string }>();
  expect({ ...replayed, loadedAt: original.loadedAt }).toEqual(original);
  expect(await nats.store.head()).toBe(position);
}
it('keeps pending revokes visible, omits departed choices and restores equal reads by replay', reportsLagAndReplays);

function foreignGrantEvent(record: EventEnvelope): EventEnvelope {
  return { ...record, silo: 'foreign' };
}

function wrongGrantEventType(record: EventEnvelope): EventEnvelope {
  return { ...record, type: 'member.removed' };
}

function differentGrantHolder(record: EventEnvelope): EventEnvelope {
  const fields = grantRevokedDataSchema.parse(record.data);
  return { ...record, data: { ...fields, granteeId: 'another-person' } };
}

async function refusesMismatchedGrantEvent(change: (record: EventEnvelope) => EventEnvelope) {
  const revoke = await append(subject, 'grant.revoked', { resourceType: 'mcp_server',
    resourceId: 'fixture', granteeId: 'bob', granteeKind: 'member', revokedBy: 'owner' });
  await project();
  expect((await get()).statusCode).toBe(200);
  const read = nats.store.readStream.bind(nats.store);
  let replacements = 0;
  // Simulate a damaged referenced event while keeping its id and position unchanged.
  nats.store.readStream = async function* mismatched(stream, from, deadline) {
    for await (const row of read(stream, from, deadline)) {
      if (stream === subject && row.event.id === revoke.id) {
        replacements += 1;
        yield { ...row, event: change(row.event) };
      } else {
        yield row;
      }
    }
  };
  try {
    const response = await get();
    expect(replacements).toBe(1);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    nats.store.readStream = read;
  }
}

async function refusesForeignGrantEvent() {
  await refusesMismatchedGrantEvent(foreignGrantEvent);
}
it('refuses a referenced grant event from another silo', refusesForeignGrantEvent);

async function refusesWrongGrantEventType() {
  await refusesMismatchedGrantEvent(wrongGrantEventType);
}
it('refuses a referenced event with a non-grant event type', refusesWrongGrantEventType);

async function refusesDifferentGrantHolder() {
  await refusesMismatchedGrantEvent(differentGrantHolder);
}
it('refuses a referenced grant event for a different grantee', refusesDifferentGrantHolder);

async function slowReadSurvivesChatActivity() {
  const query = database.query.bind(database);
  let waited = false;
  database.query = async function slow(sql, parameters) {
    if (!waited && sql.includes('projection_checkpoints')) {
      waited = true;
      await append('conversation-unrelated', 'agent.turn_started',
        { conversationId: 'unrelated', turnId: 'unrelated-turn', assistantId: 'helper' });
      await delay(2100);
    }
    return query(sql, parameters);
  };
  try {
    expect((await get()).statusCode).toBe(200);
    expect(waited).toBe(true);
  } finally {
    database.query = query;
  }
}
it('allows authorised reads over two seconds despite unrelated chat activity', slowReadSurvivesChatActivity);

async function unavailableReadIsSanitised() {
  const query = database.query.bind(database);
  database.query = function unavailable() {
    return Promise.reject(new Error('private-error-canary'));
  };
  try {
    for (const url of [path, `${path}/candidates?kind=member`]) {
      const response = await get(url);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'unavailable' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('private-error-canary');
    }
  } finally {
    database.query = query;
  }
}
it('returns an unknown read outcome without exposing private error details', unavailableReadIsSanitised);

async function overflowIsIncomplete() {
  expect((await get()).statusCode).toBe(200);
  for (let index = 0; index < 101; index++) {
    await append(subject, 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind: 'member', granteeId: `historical-${index}`, grantedBy: 'owner' }, 'acme', false);
  }
  await project();
  const response = await get();
  expect(response.json()).toMatchObject({ complete: false, grantTotal: null });
  expect(response.json<{ grants: unknown[] }>().grants).toHaveLength(100);
}
it('marks overflowing grants incomplete without inventing an exact audience count', overflowIsIncomplete, 120_000);
