import { legacyMemberRole } from '@opencrane/events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history, seedOwnership } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditTrail, members, pgDb, ProjectionRunner,
  readEvents, rebuildMemberProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { ownershipCommand } from '../src/members/ownership.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let count = 0;
const logger = createLogger('ownership-test', { level: 'silent' });

async function append(subject: string, type: string, data: unknown, silo = 'acme') {
  const record = {
    ...event(`ownership-fixture-${++count}`, subject, type), silo, data,
    correlation: {}, principal: { kind: 'human' as const, id: 'idp-owner' },
  };
  const expectedSequence = await nats.store.head(subject);
  expect((await nats.store.append({ event: record, expectedSequence })).status).toBe('appended');
  return record;
}
async function project() {
  const head = await nats.reader.head();
  for await (const row of readEvents(nats.reader, 1, head)) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  await runner.run(members);
}
function resolveMemberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject.replace('idp-', ''));
}
function request(method: 'GET' | 'POST', payload?: unknown, sub = 'idp-owner',
  url = '/api/ownership', orgId = 'org-acme') {
  const email = `${sub.slice(4)}@example.test`;
  const authTime = Math.floor(Date.now() / 1000);
  const session = { sub, orgId, roles: [], authTime, exp: 2000000000,
    email, emailVerified: true };
  const headers = {
    origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}`,
  };
  return app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(members);
  await runner.initialise(auditTrail);
  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member'], ['admin', 'admin']]) {
    const data = { memberId, email: `${memberId}@example.test`, displayName: memberId, role };
    const joined = await append(`member-${memberId}`, 'member.joined', data);
    await auth.handler.handle(joined, db);
  }
  await seedOwnership(nats.store, 'acme');
  await project();
  const options = {
    silo: 'acme', store: nats.store, db, binding, feed: { memberId: resolveMemberId },
  };
  app = buildServer(config, { ownership: options, memberReads: options });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

function roleRequest(memberId: string, input: unknown, actor = 'idp-owner') {
  return request('POST', input, actor, `/api/members/${memberId}/role`);
}
async function status(memberId: string, commandId: string, actor = 'idp-owner') {
  return request('GET', undefined, actor, `/api/members/${memberId}/changes/${commandId}`);
}
async function changesRoles() {
  const input = { commandId: 'promote', newRole: 'admin',
    expectedSequence: await nats.store.head('member-bob') };
  const response = await roleRequest('bob', input);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'recorded', commandId: 'promote' });
  expect((await roleRequest('bob', input)).json()).toEqual(response.json());
  expect((await roleRequest('bob', { ...input, newRole: 'member' })).statusCode).toBe(409);
  const rows = await history(nats.store, 'member-bob', 'acme');
  expect(rows).toHaveLength(2);
  expect(rows[1]?.event.data).toMatchObject({ previousRole: 'member', newRole: 'admin',
    changedBy: 'owner' });
  expect((await status('bob', 'promote')).json()).toMatchObject({
    projection: { content: 'applying', iam: 'applying' } });
  await project();
  expect((await auth.check('bob', 'admin')).allowed).toBe(true);
  const demotion = { commandId: 'self-demote', newRole: 'member',
    expectedSequence: await nats.store.head('member-admin') };
  expect((await roleRequest('admin', demotion, 'idp-admin')).statusCode).toBe(200);
  // Read the actor's own receipt while IAM still holds the old Admin permission.
  expect((await status('admin', 'self-demote', 'idp-admin')).statusCode).toBe(200);
  await project();
  const own = await status('admin', 'self-demote', 'idp-admin');
  expect(own.statusCode).toBe(200);
  expect(own.json()).toMatchObject({ commandId: 'self-demote',
    projection: { content: 'current', iam: 'current' } });
  expect(JSON.stringify(own.json())).not.toContain('example.test');
  expect((await status('bob', 'promote', 'idp-admin')).statusCode).toBe(403);
  expect((await roleRequest('bob', demotion, 'idp-admin')).statusCode).toBe(403);
}
it('records roles once and keeps a minimal own receipt after self-demotion', changesRoles);

async function refusesBypasses() {
  const before = await nats.store.head();
  const input = { commandId: 'bypass', newRole: 'admin',
    expectedSequence: await nats.store.head('member-owner') };
  expect((await roleRequest('owner', input)).statusCode).toBe(409);
  expect((await roleRequest('bob', { ...input, newRole: 'owner' })).statusCode).toBe(400);
  expect((await roleRequest('bob', { ...input, changedBy: 'owner' })).statusCode).toBe(400);
  expect((await roleRequest('missing', input)).statusCode).toBe(409);
  expect((await request('POST', input, 'idp-owner', '/api/members/bob/role', 'foreign'))
    .statusCode).toBe(403);
  const invalidOrigin = { origin: 'https://app.example.test.evil',
    cookie: `${config.cookieName}=${encodeSession(config, { sub: 'idp-owner', orgId: 'org-acme',
      roles: [], authTime: Math.floor(Date.now() / 1000), exp: 2000000000 })}` };
  expect((await app.inject({ method: 'POST', url: '/api/members/bob/role',
    headers: invalidOrigin, payload: input })).statusCode).toBe(403);
  expect(await nats.store.head()).toBe(before);
}
it('refuses owner edits and untrusted or unsupported input without an event', refusesBypasses);

async function racesAppointment(appointmentFirst: boolean) {
  const memberId = appointmentFirst ? 'race-before' : 'race-after';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, email: `${memberId}@example.test`, displayName: memberId, role: 'member' });
  await project();
  const input = { commandId: memberId, newRole: 'admin',
    expectedSequence: await nats.store.head(`member-${memberId}`) };
  const original = nats.store.append.bind(nats.store);
  async function appoint() {
    await append('ownership-acme', 'ownership.transferred', {
      memberId, transferredBy: 'owner' });
  }
  async function appendInOrder(command: Parameters<typeof original>[0]) {
    expect(command.historyChecked).toBe(true);
    if (appointmentFirst) await appoint();
    const result = await original(command);
    if (!appointmentFirst) await appoint();
    return result;
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(appendInOrder);
  try {
    expect((await roleRequest(memberId, input)).statusCode).toBe(200);
  } finally {
    spy.mockRestore();
  }
  await project();
  expect((await auth.check(memberId, 'owner')).allowed).toBe(true);
  expect(await auth.applied((await history(nats.store, `member-${memberId}`, 'acme'))[1]!
    .event.id)).toBe(true);
  const content = await dbs.queue.query('SELECT role FROM members WHERE member_id = $1', [memberId]);
  expect(content.rows).toEqual([{ role: 'owner' }]);
  expect((await status(memberId, memberId)).json()).toMatchObject({
    effect: 'none_target_became_owner', projection: { content: 'current', iam: 'current' } });
  await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
  await rebuildMembers(fga.apiUrl, 'acme', nats.reader, { verifyAgainst: auth.binding });
}
it.each([true, false])('keeps both projections running across appointment order %s', racesAppointment);

async function refusesInactiveRemainingOwners() {
  // Keep the malformed old owner removals out of the live projections.
  const owners = ['race-before', 'race-after'];
  for (const memberId of owners) {
    await append('ownership-acme', 'ownership.transferred', {
      memberId, transferredBy: 'owner' });
    await append(`member-${memberId}`, 'member.removed', { memberId, removedBy: 'owner' });
  }
  const input = { action: 'step_down', commandId: 'inactive-owners',
    expectedSequence: await nats.store.head('ownership-acme') };
  const before = await nats.store.head();
  await expect(ownershipCommand(nats.store, auth.binding, 'owner', input))
    .rejects.toThrow('last_owner');
  expect(await nats.store.head()).toBe(before);
  for (const memberId of owners) {
    const rows = await history(nats.store, `member-${memberId}`, 'acme');
    expect(legacyMemberRole(rows.at(-1)!.event)).toBe('');
  }
}
it('the backend refuses step-down when all other owners have been removed',
  refusesInactiveRemainingOwners);
