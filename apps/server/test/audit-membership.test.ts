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
  const events = [role, intent, confirmation, appointment, stepDown];
  const expected = [
    { operation: 'role_change', memberId: 'member', previousRole: 'member', newRole: 'admin' },
    { operation: 'transfer_intent', memberId: 'member' },
    { operation: 'ownership_confirmation', memberId: 'member',
      appointmentId: 'intent', newRole: 'owner' },
    { operation: 'appointment', memberId: 'member', newRole: 'owner' },
    { operation: 'step_down', memberId: 'owner', previousRole: 'owner', newRole: 'admin' },
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

async function blockedRead(change: 'demotion' | 'removal' | 'slow') {
  await append(role);
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
  const response = await app.inject({ url: '/api/org/history/role', headers: headers() });
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
