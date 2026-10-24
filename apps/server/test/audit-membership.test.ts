import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditDetailSchema, auditResponseSchema } from '@opencrane/protocol';
import { auditTrail, connectMemberFeed, members, pgDb, ProjectionRunner,
  readAudit, rebuildAuditProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
const canary = 'private-invitation-command-credential-canary';
const logger = createLogger('audit-membership-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let db: ReturnType<typeof pgDb>;
let auth: ReturnType<typeof memberAuthorisation>;

function saved(type: string, id: string, data: Record<string, unknown>, actor = 'owner') {
  let subject = 'ownership-test';
  if (type.startsWith('member.')) subject = `member-${String(data['memberId'])}`;
  const event = envelope('test', subject, type, data, `${canary}-${id}`);
  event.id = id;
  event.time = '2026-10-03T01:02:03Z';
  event.principal = { kind: 'human', id: actor };
  return event;
}
async function append(event: EventEnvelope) {
  const expectedSequence = await nats.store.head(event.subject);
  expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
}
async function setup() {
  nats = await natsFixture();
  dbs = await databases();
  fga = await openfga();
  auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.store, logger);
  await runner.initialise(members);
  await runner.initialise(auditTrail);
  for (const role of ['owner', 'admin', 'member', 'reader'] as const) {
    const memberRole = role === 'reader' ? 'member' : role;
    const invited = saved('member.invited', `invite-${role}`, {
      memberId: role, role: memberRole, email: `${canary}@example.test`, invitedBy: 'owner',
      invitationId: `invitation-${role}`, invitedIdentity: { issuer: config.issuerUrl, sub: role },
      expiresAt: '2030-01-01T00:00:00Z',
    });
    const joined = saved('member.joined', `join-${role}`, {
      memberId: role, role: memberRole, email: `${canary}@example.test`, displayName: canary,
      invitationId: `invitation-${role}`,
    }, role);
    await append(invited);
    await append(joined);
    await auth.handler.handle(joined, db);
  }
  const seed = saved('ownership.seeded', 'ownership-seed-test', { ownerIds: ['owner'] });
  await append(seed);
  await auth.handler.handle(seed, db);
  await runner.run(members);
  feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const audit = { silo: 'test', store: nats.store, db, feed, binding: auth.binding };
  app = buildServer(config, { audit });
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await feed?.close();
  await fga?.close();
  await dbs?.close();
  await nats?.close();
}
beforeEach(setup, 120_000);
afterEach(cleanup);
function headers(member = 'admin', orgId = 'org-acme') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: member, orgId, roles: [], authTime: now, exp: now + 600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function detail(id: string) {
  const response = await app.inject({ url: `/api/org/history/${id}`, headers: headers() });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(canary);
  const result = auditDetailSchema.parse(response.json());
  expect(result.records).toHaveLength(1);
  return result.records[0]!;
}
const role = saved('member.role_changed', 'role', {
  memberId: 'member', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
});
const removal = saved('member.removed', 'removal', {
  memberId: 'member', removedBy: 'owner', reason: 'access_removed',
});
const intent = saved('ownership.transferred', 'intent', {
  memberId: 'member', transferredBy: 'owner', awaitingConfirmation: true,
});
const confirmation = saved('member.ownership_confirmed', 'confirmation', {
  memberId: 'member', appointmentId: 'intent',
});
confirmation.principal = { kind: 'system', id: 'confirmation-worker' };

async function safeMetadata() {
  const appointment = saved('ownership.transferred', 'appointment', {
    memberId: 'member', transferredBy: 'owner',
  });
  const stepDown = saved('ownership.stepped_down', 'step-down', { memberId: 'owner' });
  const events = [role, intent, confirmation, appointment, stepDown, removal];
  const expected = [
    { operation: 'role_change', memberId: 'member', previousRole: 'member', newRole: 'admin' },
    { operation: 'transfer_intent', memberId: 'member' },
    { operation: 'ownership_confirmation', memberId: 'member',
      appointmentId: 'intent', newRole: 'owner' },
    { operation: 'appointment', memberId: 'member', newRole: 'owner' },
    { operation: 'step_down', memberId: 'owner', previousRole: 'owner', newRole: 'admin' },
    { operation: 'remove', memberId: 'member', reason: 'Membership has ended' },
  ];
  for (const event of events) await append(event);
  await runner.run(auditTrail);
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const record = await detail(event.id);
    expect(record).toMatchObject(expected[index]!);
    expect(record.recordedAt).toBe(event.time);
    const kind = event === confirmation ? 'system' : 'person';
    expect(record.actor).toEqual({ kind, id: event.principal!.id });
    const hash = createHash('sha256');
    hash.update(event.commandId!);
    expect(record.commandRef).toBe(hash.digest('hex'));
    expect(record.status).toBe('recorded');
  }
  expect((await detail('intent')).newRole).toBeUndefined();
  const before = await readAudit(pgDb(dbs.queue), 'test');
  expect(JSON.stringify(before)).not.toContain('checkedAt');
  expect(JSON.stringify(before)).not.toContain(canary);
  const appends = vi.spyOn(nats.store, 'append');
  await rebuildAuditProjection(pgDb(dbs.queue), nats.store, logger, { verify: true });
  expect(await readAudit(pgDb(dbs.queue), 'test')).toEqual(before);
  expect(appends).not.toHaveBeenCalled();
  const roleData = z.record(z.string(), z.unknown()).parse(role.data);
  const spoofed = { ...role, id: 'spoofed', data: { ...roleData, actor: 'mallory' },
    principal: { kind: 'human' as const, id: 'mallory' } };
  const agent = { ...role, id: 'agent', principal: { kind: 'agent' as const, id: 'owner' } };
  await auditTrail.apply(pgDb(dbs.queue), spoofed, 100);
  await auditTrail.apply(pgDb(dbs.queue), agent, 101);
  expect((await detail('spoofed')).actor).toEqual({ kind: 'unverified' });
  expect((await detail('agent')).actor).toEqual({ kind: 'agent', id: 'owner' });
}
it('keeps distinct safe role and ownership facts and verified actors through replay', safeMetadata);

async function exactProgress(intentFirst: boolean) {
  await append(role);
  await append(intent);
  await runner.run(auditTrail);
  const appends = vi.spyOn(nats.store, 'append');
  const firstRead = await detail('role');
  expect(firstRead).toMatchObject({ progress: { readModel: 'applying', iam: 'applying' } });
  await runner.run(members);
  if (intentFirst) await auth.handler.handle(intent, db);
  expect(await detail('intent')).toMatchObject({ progress: { readModel: 'applying', iam: 'applying' } });
  expect(await detail('role')).toMatchObject({ progress: { readModel: 'current', iam: 'applying' } });
  expect(appends).not.toHaveBeenCalled();
  appends.mockRestore();
  const otherIntent = saved('ownership.transferred', 'other-intent', {
    memberId: 'member', transferredBy: 'owner', awaitingConfirmation: true,
  });
  const otherConfirmation = saved('member.ownership_confirmed', 'other-confirmation', {
    memberId: 'member', appointmentId: 'other-intent',
  });
  await append(otherIntent);
  await append(otherConfirmation);
  await runner.run(auditTrail);
  await runner.run(members);
  await auth.handler.handle(otherIntent, db);
  await auth.handler.handle(otherConfirmation, db);
  expect(await detail('intent')).toMatchObject({
    progress: { readModel: 'applying', iam: 'applying' },
  });
  await append(confirmation);
  const later = saved('member.role_changed', 'later', {
    memberId: 'member', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
  });
  await append(later);
  await runner.run(auditTrail);
  expect(await detail('confirmation')).toMatchObject({
    progress: { readModel: 'applying', iam: 'applying' },
  });
  expect(await detail('intent')).toMatchObject({
    progress: { readModel: 'applying', iam: 'applying' },
  });
  await runner.run(members);
  expect(await detail('confirmation')).toMatchObject({
    progress: { readModel: 'current', iam: 'applying' },
  });
  await auth.handler.handle(confirmation, pgDb(dbs.queue));
  await auth.handler.handle(later, pgDb(dbs.queue));
  expect(await detail('intent')).toMatchObject({ progress: { readModel: 'current', iam: intentFirst ? 'current' : 'applying' } });
  await auth.handler.handle(intent, db);
  expect(await detail('intent')).toMatchObject({ progress: { readModel: 'current', iam: 'current' } });
  expect(await detail('confirmation')).toMatchObject({
    progress: { readModel: 'current', iam: 'current' },
  });
  expect(await detail('role')).toMatchObject({ progress: { readModel: 'current', iam: 'applying' } });
  const before = await readAudit(pgDb(dbs.queue), 'test');
  await rebuildAuditProjection(pgDb(dbs.queue), nats.store, logger, { verify: true });
  await auth.handler.handle(role, pgDb(dbs.queue));
  const lastRead = await detail('role');
  expect(lastRead).toMatchObject({ progress: { readModel: 'current', iam: 'current' } });
  expect(lastRead.progress?.checkedAt).not.toBe(firstRead.progress?.checkedAt);
  expect(await readAudit(pgDb(dbs.queue), 'test')).toEqual(before);
  const missing = await app.inject({ url: '/api/org/history/unknown', headers: headers() });
  expect(missing.statusCode).toBe(404);
}
it.each([true, false])(
  'checks exact receipts despite later roles and replay, intent IAM first: %s', exactProgress);

async function blockedRead(change: 'demotion' | 'removal' | 'slow', target = role) {
  await append(target);
  await runner.run(auditTrail);
  const query = db.query.bind(db);
  let blocked = false;
  async function holdQuery<Row extends Record<string, unknown>>(
    ...args: Parameters<typeof db.query>
  ) {
    if (!blocked && String(args[0]).includes('projection_events')) {
      blocked = true;
      if (change === 'slow') {
        await delay(2100);
      } else {
        let event = saved('member.removed', 'removed-admin', {
          memberId: 'admin', removedBy: 'owner',
        });
        if (change === 'demotion') {
          event = saved('member.role_changed', 'demoted-admin', {
            memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
          });
        }
        await append(event);
        // Exclude the fixture write when counting the route's access reads.
        reads.mockClear();
        heads.mockClear();
      }
    }
    return query<Row>(...args);
  }
  vi.spyOn(db, 'query').mockImplementation(holdQuery);
  const reads = vi.spyOn(nats.store, 'readStream');
  const heads = vi.spyOn(nats.store, 'head');
  const response = await app.inject({ url: `/api/org/history/${target.id}`, headers: headers() });
  expect(blocked).toBe(true);
  expect(response.statusCode).toBe(change === 'slow' ? 200 : 403);
  if (change !== 'slow') expect(response.body).not.toContain('member');
  function subject(call: Parameters<typeof nats.store.readStream>) {
    return call[0];
  }
  expect(reads.mock.calls.map(subject)).toEqual(['member-admin', 'ownership-test']);
  expect(heads).not.toHaveBeenCalled();
}
it.each(['demotion', 'removal', 'slow'] as const)(
  'checks access once after a blocked progress read: %s', blockedRead);

async function blockedRemovalRead(change: 'demotion' | 'removal' | 'slow') {
  await blockedRead(change, removal);
}
it.each(['demotion', 'removal', 'slow'] as const)(
  'checks access once after a blocked removal progress read: %s', blockedRemovalRead);

async function privateReads() {
  await append(role);
  const foreign = { ...role, id: 'foreign-role', silo: 'foreign', subject: 'member-foreign' };
  await append(foreign);
  await runner.run(auditTrail);
  for (const path of ['', '/role']) {
    for (const [member, org] of [['reader', 'org-acme'], ['outsider', 'org-acme'],
      ['admin', 'foreign-org']]) {
      const response = await app.inject({ url: `/api/org/history${path}`,
        headers: headers(member, org) });
      expect(response.statusCode).toBe(403);
      expect(response.body).toBe('{"status":"refused"}');
    }
  }
  const response = await app.inject({ url: '/api/org/history', headers: headers() });
  expect(response.body).not.toContain(canary);
  expect(response.body).not.toContain('foreign-role');
  expect(auditResponseSchema.parse(response.json()).rows.length).toBeGreaterThan(0);
  const detailResponse = await app.inject({ url: '/api/org/history/foreign-role', headers: headers() });
  expect(detailResponse.statusCode).toBe(404);
}
it('withholds private values and target ids from outsiders and foreign silos', privateReads);

type RefusedCaller = 'ordinary' | 'demoted' | 'removed';

async function refusedMember(caller: RefusedCaller, applyPermissions = false) {
  if (caller === 'ordinary') {
    return 'reader';
  }
  let change = saved('member.removed', 'removed-admin', {
    memberId: 'admin', removedBy: 'owner',
  });
  if (caller === 'demoted') {
    change = saved('member.role_changed', 'demoted-admin', {
      memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
    });
  }
  await append(change);
  if (applyPermissions) {
    await auth.handler.handle(change, db);
  }
  // Keep the identity mapping so removed people still reach the saved-membership check.
  return 'admin';
}

function streamSubject(call: Parameters<typeof nats.store.readStream>) {
  return call[0];
}

async function unavailableProgress(caller: RefusedCaller) {
  await append(role);
  await append(intent);
  await append(removal);
  const foreign = { ...role, id: 'foreign-role', silo: 'foreign', subject: 'member-foreign' };
  await append(foreign);
  const foreignRemoval = { ...removal, id: 'foreign-removal', silo: 'foreign',
    subject: 'member-foreign' };
  await append(foreignRemoval);
  await runner.run(auditTrail);
  const memberId = await refusedMember(caller);
  await app.close();
  const binding = { ...auth.binding, apiUrl: 'http://127.0.0.1:1' };
  const audit = { silo: 'test', store: nats.store, db, feed, binding };
  app = buildServer(config, { audit });
  const reads = vi.spyOn(nats.store, 'readStream');
  const heads = vi.spyOn(nats.store, 'head');
  const appends = vi.spyOn(nats.store, 'append');
  for (const id of ['unknown', 'foreign-role', 'role', 'intent', 'removal', 'foreign-removal']) {
    reads.mockClear();
    const request = { url: `/api/org/history/${id}`, headers: headers(memberId) };
    const response = await app.inject(request);
    expect.soft(response.statusCode, id).toBe(403);
    expect.soft(response.body, id).toBe('{"status":"refused"}');
    expect.soft(response.headers['cache-control'], id).toBe('no-store');
    const subjects = reads.mock.calls.map(streamSubject);
    expect.soft(subjects, id).toEqual([`member-${memberId}`, 'ownership-test']);
  }
  expect(heads).not.toHaveBeenCalled();
  expect(appends).not.toHaveBeenCalled();
}
it.each(['ordinary', 'demoted', 'removed'] as const)(
  'hides existing, missing and foreign history during an IAM outage from %s callers',
  unavailableProgress);

async function authorisedRemovalOutage() {
  await append(removal);
  await runner.run(auditTrail);
  await app.close();
  const binding = { ...auth.binding, apiUrl: 'http://127.0.0.1:1' };
  const audit = { silo: 'test', store: nats.store, db, feed, binding };
  app = buildServer(config, { audit });
  const reads = vi.spyOn(nats.store, 'readStream');
  const response = await app.inject({ url: '/api/org/history/removal', headers: headers() });
  expect(response.statusCode).toBe(503);
  expect(response.body).toBe('{"status":"unavailable"}');
  expect(response.headers['cache-control']).toBe('no-store');
  const subjects = reads.mock.calls.map(streamSubject);
  expect(subjects).toEqual(['member-admin', 'ownership-test']);
}
it('keeps authorised removal reads unavailable during an IAM outage', authorisedRemovalOutage);

async function failedHistoryReads(caller: RefusedCaller) {
  // Apply demotion so conversation access reaches its permission check, rather than missing IAM.
  const memberId = await refusedMember(caller, true);
  const reads = vi.spyOn(nats.store, 'readStream');
  const heads = vi.spyOn(nats.store, 'head');
  const appends = vi.spyOn(nats.store, 'append');
  function failQuery(): ReturnType<typeof db.query> {
    expect(reads).not.toHaveBeenCalled();
    return Promise.reject(new Error(canary));
  }
  const queries = vi.spyOn(db, 'query').mockImplementation(failQuery);
  const paths = ['/api/org/history', '/api/org/history/role', '/api/org/history/removal',
    '/api/org/history/foreign-removal', '/api/org/history/unknown',
    '/api/org/history/foreign-role', '/api/conversations/protected/history'];
  for (const url of paths) {
    reads.mockClear();
    queries.mockClear();
    const request = { url, headers: headers(memberId) };
    const response = await app.inject(request);
    expect.soft(response.statusCode, url).toBe(403);
    expect.soft(response.body, url).toBe('{"status":"refused"}');
    expect.soft(response.headers['cache-control'], url).toBe('no-store');
    expect.soft(queries, url).toHaveBeenCalled();
    const subjects = reads.mock.calls.map(streamSubject);
    expect.soft(subjects, url).toEqual([`member-${memberId}`, 'ownership-test']);
  }
  expect(heads).not.toHaveBeenCalled();
  expect(appends).not.toHaveBeenCalled();
}
it.each(['ordinary', 'demoted', 'removed'] as const)(
  'checks access after failed list and detail loading for %s callers', failedHistoryReads);

async function authorisedLoadFailure(stage: 'history' | 'progress') {
  await append(role);
  await append(removal);
  await runner.run(auditTrail);
  const reads = vi.spyOn(nats.store, 'readStream');
  const query = db.query.bind(db);
  async function failLoad<Row extends Record<string, unknown>>(
    ...args: Parameters<typeof db.query>
  ) {
    if (stage === 'history' || String(args[0]).includes('projection_events')) {
      expect(reads).not.toHaveBeenCalled();
      throw new Error(canary);
    }
    return query<Row>(...args);
  }
  vi.spyOn(db, 'query').mockImplementation(failLoad);
  const paths = ['/api/org/history/role', '/api/org/history/removal'];
  if (stage === 'history') {
    paths.push('/api/org/history');
  }
  for (const url of paths) {
    reads.mockClear();
    const request = { url, headers: headers() };
    const response = await app.inject(request);
    expect.soft(response.statusCode, url).toBe(503);
    expect.soft(response.body, url).toBe('{"status":"unavailable"}');
    expect.soft(response.headers['cache-control'], url).toBe('no-store');
    const subjects = reads.mock.calls.map(streamSubject);
    expect.soft(subjects, url).toEqual(['member-admin', 'ownership-test']);
  }
}
it.each(['history', 'progress'] as const)(
  'returns a fixed loading error only after checking authorised access: %s',
  authorisedLoadFailure);

async function removalMetadata() {
  const privateData = { memberId: 'member', removedBy: 'owner', reason: canary,
    email: `${canary}@example.test`, displayName: canary, invitationId: canary,
    inventory: [canary], privateCount: 12345, instructions: canary };
  const untrusted = { ...removal, id: 'untrusted-removal', data: privateData };
  const forged = { ...removal, id: 'forged-removal', data: {
    memberId: 'member', removedBy: 'mallory', actor: 'owner',
  } };
  const otherPrincipal = saved('member.removed', 'different-principal', {
    memberId: 'member', removedBy: 'owner',
  }, 'mallory');
  const agent = { ...removal, id: 'agent-removal',
    principal: { kind: 'agent' as const, id: 'owner' } };
  const events = [untrusted, forged, otherPrincipal, agent];
  let position = 100;
  for (const event of events) {
    await auditTrail.apply(db, event, position++);
  }
  const record = await detail(untrusted.id);
  const hash = createHash('sha256');
  hash.update(untrusted.commandId!);
  expect(record).toEqual({ eventId: untrusted.id, type: 'member.removed', position: 100,
    operation: 'remove', memberId: 'member', reason: 'Recorded reason withheld',
    actor: { kind: 'person', id: 'owner' }, recordedAt: untrusted.time,
    commandRef: hash.digest('hex'), source: 'authoritative', status: 'recorded',
    progress: { readModel: 'applying', iam: 'applying', checkedAt: expect.any(String) } });
  expect((await detail(forged.id)).actor).toEqual({ kind: 'unverified' });
  expect((await detail(otherPrincipal.id)).actor).toEqual({ kind: 'unverified' });
  expect((await detail(agent.id)).actor).toEqual({ kind: 'agent', id: 'owner' });
  expect((await detail(forged.id)).reason).toBeUndefined();
}
it('keeps removal metadata safe and rejects forged removers and different principals',
  removalMetadata);

async function removalProgress(iamFirst: boolean) {
  await append(removal);
  await runner.run(auditTrail);
  const first = await detail(removal.id);
  expect(first.progress).toMatchObject({ readModel: 'applying', iam: 'applying' });
  const rejoined = saved('member.joined', 'rejoined', {
    memberId: 'member', role: 'member', email: `${canary}@example.test`, displayName: canary,
  }, 'member');
  const removedAgain = { ...removal, id: 'removed-again' };
  for (const event of [rejoined, role, removedAgain]) {
    await append(event);
    await auth.handler.handle(event, db);
    expect((await detail(removal.id)).progress).toMatchObject({
      readModel: 'applying', iam: 'applying',
    });
  }
  await runner.run(auditTrail);
  await runner.run(members);
  // Simulate the original receipt being absent while every later receipt exists.
  await db.query('DELETE FROM projection_events WHERE projection = $1 AND event_id = $2',
    ['members', removal.id]);
  expect((await detail(removal.id)).progress).toMatchObject({
    readModel: 'applying', iam: 'applying',
  });
  if (iamFirst) {
    await auth.handler.handle(removal, db);
    expect((await detail(removal.id)).progress).toMatchObject({
      readModel: 'applying', iam: 'current',
    });
  }
  await runner.rebuild(members);
  const expectedIam = iamFirst ? 'current' : 'applying';
  expect((await detail(removal.id)).progress).toMatchObject({
    readModel: 'current', iam: expectedIam,
  });
  const before = await readAudit(db, 'test');
  expect(JSON.stringify(before)).not.toContain('checkedAt');
  expect(JSON.stringify(before)).not.toContain(canary);
  const appends = vi.spyOn(nats.store, 'append');
  const permissionWrites = vi.spyOn(auth.handler, 'handle');
  await rebuildAuditProjection(db, nats.store, logger, { verify: true });
  expect(await readAudit(db, 'test')).toEqual(before);
  expect((await detail(removal.id)).progress).toMatchObject({
    readModel: 'current', iam: expectedIam,
  });
  expect(permissionWrites).not.toHaveBeenCalled();
  await auth.handler.handle(removal, db);
  const last = await detail(removal.id);
  expect(last.progress).toEqual({
    readModel: 'current', iam: 'current', checkedAt: expect.any(String),
  });
  expect(last.progress?.checkedAt).not.toBe(first.progress?.checkedAt);
  expect(await readAudit(db, 'test')).toEqual(before);
  expect(last).not.toHaveProperty('cleanup');
  expect(appends).not.toHaveBeenCalled();
}
it.each([true, false])(
  'requires exact removal receipts despite rejoin, role change, removal and replay: IAM first %s',
  removalProgress);

async function removalPaging() {
  for (let index = 0; index < 52; index++) {
    const event = { ...removal, id: `removal-${index}`,
      correlation: { conversation: 'conversation', turn: 'departures' } };
    await append(event);
  }
  await runner.run(auditTrail);
  const appends = vi.spyOn(nats.store, 'append');
  const firstResponse = await app.inject({
    url: '/api/org/history/removal-0?limit=50', headers: headers(),
  });
  expect(firstResponse.statusCode).toBe(200);
  const first = auditDetailSchema.parse(firstResponse.json());
  expect(first.records).toHaveLength(50);
  expect(first.nextBefore).toBeDefined();
  const nextResponse = await app.inject({
    url: `/api/org/history/removal-0?limit=50&before=${String(first.nextBefore)}`,
    headers: headers(),
  });
  expect(nextResponse.statusCode).toBe(200);
  const next = auditDetailSchema.parse(nextResponse.json());
  expect(next.records).toHaveLength(2);
  expect(next.nextBefore).toBeUndefined();
  const ids = new Set<string>();
  for (const record of [...first.records, ...next.records]) {
    ids.add(record.eventId);
    expect(record.operation).toBe('remove');
    expect(record.progress).toMatchObject({ readModel: 'applying', iam: 'applying' });
  }
  expect(ids.size).toBe(52);
  expect(appends).not.toHaveBeenCalled();
}
it('keeps removal detail pages bounded without repeating or skipping records', removalPaging);
