import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditResponseSchema, auditDetailSchema } from '@opencrane/protocol';
import { auditTrail, connectMemberFeed, members, pgDb, ProjectionRunner,
  rebuildAuditProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
const privateText = 'private-report-child-title-and-storage-key-canary';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let db: ReturnType<typeof pgDb>;
let auth: ReturnType<typeof memberAuthorisation>;

function headers(memberId: string) {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId: 'org-test', roles: [], authTime: now, exp: now + 600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}

async function append(subject: string, type: string, data: object, id: string) {
  const event = envelope('test', subject, type, data, privateText);
  event.id = id;
  event.time = '2026-10-15T12:00:00Z';
  event.principal = { kind: 'human', id: 'owner' };
  const expectedSequence = await nats.store.head(subject);
  expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
  if (['member.joined', 'conversation.created', 'member.removed'].includes(type)) {
    await auth.handler.handle(event, db);
  }
  return event;
}

async function setup() {
  nats = await natsFixture();
  dbs = await databases();
  fga = await openfga();
  db = pgDb(dbs.queue);
  auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  runner = new ProjectionRunner(db, nats.store,
    createLogger('audit-child-publication-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(auditTrail);
  for (const memberId of ['owner', 'admin', 'guest']) {
    const role = memberId === 'owner' ? 'owner' : memberId === 'admin' ? 'admin' : 'member';
    await append(`member-${memberId}`, 'member.invited', {
      memberId, role, invitationId: `invite-${memberId}`, invitedBy: 'owner',
      email: `${memberId}@example.test`,
      invitedIdentity: { issuer: config.issuerUrl, sub: memberId },
      expiresAt: '2030-01-01T00:00:00Z',
    }, `invite-${memberId}`);
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, invitationId: `invite-${memberId}`,
      email: `${memberId}@example.test`, displayName: memberId,
    }, `join-${memberId}`);
  }
  const ownership = envelope('test', 'ownership-test', 'ownership.seeded', {
    ownerIds: ['owner'],
  });
  await nats.seed([ownership]);
  await auth.handler.handle(ownership, db);
  await append('conversation-parent', 'conversation.created', {
    conversationId: 'parent', createdBy: 'owner', mode: 'group', participantIds: ['owner', 'guest'],
  }, 'parent-created');
  await append('conversation-child', 'conversation.created', {
    conversationId: 'child', createdBy: 'admin', mode: 'group', participantIds: ['admin', 'guest'],
  }, 'child-created');
  await runner.run(members);
  await runner.run(auditTrail);
  feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  app = buildServer(config, { audit: { silo: 'test', store: nats.store, db, feed,
    binding: auth.binding } });
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

async function publish(id: string, withResult = true) {
  const data = {
    conversationId: 'parent', childConversationId: 'child', publishedBy: 'owner',
    publicationKind: withResult ? 'final' : 'interim',
    ...(withResult ? { resultEventId: 'child-result', resultPosition: 2, turnId: 'turn' } : {}),
    reviewDigest: 'a'.repeat(64), contentType: 'text',
    ciphertext: Buffer.from(privateText).toString('base64'), keyId: 'key:1',
  };
  await append('conversation-parent', 'conversation.child_result_published', data, id);
  await runner.run(auditTrail);
}

async function list(memberId: string, query = '?type=conversation') {
  return app.inject({ url: `/api/org/history${query}`, headers: headers(memberId) });
}
async function detail(memberId: string, id: string) {
  return app.inject({ url: `/api/org/history/${id}`, headers: headers(memberId) });
}

it('shows only independently permitted publication facts and a parent task link', async () => {
  await publish('publication');
  const before = await nats.store.head();
  const appends = vi.spyOn(nats.store, 'append');
  for (const [memberId, visibleId, hiddenId] of [
    ['owner', 'parent', 'child'], ['admin', 'child', 'parent'],
  ]) {
    const response = await list(memberId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(privateText);
    expect(response.body).toContain(visibleId!);
    expect(response.body).not.toContain(`"${hiddenId}"`);
    const page = auditResponseSchema.parse(response.json());
    expect(page.rows.filter(row => row.id === 'publication')).toHaveLength(1);
    const shown = await detail(memberId!, 'publication');
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.body).not.toContain(privateText);
    expect(shown.body).toContain(visibleId!);
    expect(shown.body).not.toContain(`"${hiddenId}"`);
    const record = auditDetailSchema.parse(shown.json()).records[0]!;
    expect(record.type).toBe('conversation.child_result_published');
    expect(record).not.toHaveProperty('assetCount');
    if (memberId === 'owner') {
      expect(record).toMatchObject({ parentConversationId: 'parent',
        taskHref: '/workspace?conversation=parent' });
      expect(record.childConversationId).toBeUndefined();
      expect(record.resultEventId).toBeUndefined();
    } else {
      expect(record).toMatchObject({ childConversationId: 'child',
        resultEventId: 'child-result' });
      expect(record.parentConversationId).toBeUndefined();
      expect(record.taskHref).toBeUndefined();
    }
  }
  expect(await nats.store.head()).toBe(before);
  expect(appends).not.toHaveBeenCalled();
});

it('keeps one row across duplicate publication and replay, with stable position paging', async () => {
  await publish('publication');
  await auditTrail.apply(db, (await nats.store.readEvent(await nats.store.head())).event,
    await nats.store.head());
  await publish('publication-two', false);
  const first = await list('owner', '?type=conversation&limit=1');
  expect(first.statusCode, first.body).toBe(200);
  const firstPage = auditResponseSchema.parse(first.json());
  expect(firstPage.rows).toHaveLength(1);
  const second = await list('owner', `?type=conversation&limit=1&before=${firstPage.nextBefore}`);
  const secondPage = auditResponseSchema.parse(second.json());
  expect(secondPage.rows).toHaveLength(1);
  expect(new Set([...firstPage.rows, ...secondPage.rows].map(row => row.id)).size).toBe(2);
  const before = await list('owner');
  const appends = vi.spyOn(nats.store, 'append');
  await rebuildAuditProjection(db, nats.store,
    createLogger('audit-child-publication-replay', { level: 'silent' }), { verify: true });
  const after = await list('owner');
  expect(after.json()).toEqual(before.json());
  expect(appends).not.toHaveBeenCalled();
  expect(after.body).not.toContain(privateText);
  const unknown = auditDetailSchema.parse((await detail('owner', 'publication-two')).json());
  expect(unknown.records[0]?.resultEventId).toBeUndefined();
  expect(unknown.records[0]?.status).toBe('recorded');
});

it('refuses detail after membership removal even with an old cursor', async () => {
  await publish('publication');
  const old = auditResponseSchema.parse((await list('admin')).json());
  expect(old.rows).toHaveLength(1);
  await append('member-admin', 'member.removed', {
    memberId: 'admin', removedBy: 'owner', reason: 'access_removed',
  }, 'remove-admin');
  const response = await detail('admin', 'publication');
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain(privateText);
  const continued = await list('admin', `?type=conversation&before=${old.rows[0]!.records[0]!.position}`);
  expect(continued.statusCode).toBe(403);
});
