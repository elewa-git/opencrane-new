import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from 'minio/dist/esm/minio.mjs';
import type { FastifyRequest } from 'fastify';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditResponseSchema, auditDetailSchema } from '@opencrane/protocol';
import { auditTrail, connectMemberFeed, conversations, members, pgDb, ProjectionRunner,
  readAudit, readAuditDetail, rebuildAuditProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
const privateText = 'private-report-child-title-and-storage-key-canary';
const modernDelegationExample = {
  version: 1, delegationId: 'child', rootId: 'root', rootTurnId: 'root-turn',
  rootThreadId: 'root-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  conversationId: 'child', requesterId: 'owner', payingGroupId: 'sales',
  parentTurnId: 'parent-turn', parentThreadId: 'parent-thread', turnId: 'child-turn',
  threadId: 'child-thread', spawnItemId: 'spawn', dataClass: 'private',
  scopes: { models: [], tools: [], resources: [], operations: [], destinations: [],
    connectionIds: [], profileIds: [] },
  computerAdmission: { eventId: 'admission', position: 1 },
} as const;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let db: ReturnType<typeof pgDb>;
let auth: ReturnType<typeof memberAuthorisation>;
let logArguments: unknown[];

function headers(memberId: string) {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId: 'org-test', roles: [], authTime: now, exp: now + 600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}

async function append(subject: string, type: string, data: object, id: string) {
  let event: EventEnvelope;
  if (type.startsWith('delegation.')) {
    const parsed = parseEventByType({ id, commandId: id, type, subject, silo: 'test', data,
      source: 'opencrane-server', time: '2026-10-15T12:00:00Z',
      principal: { kind: 'system', id: 'opencrane-server' },
      correlation: { conversation: privateText, turn: privateText } });
    if (!parsed.success) throw new Error('Invalid delegation fixture');
    event = parsed.event;
  } else {
    event = envelope('test', subject, type, data, `${privateText}-${id}`);
  }
  event.id = id;
  event.time = '2026-10-15T12:00:00Z';
  if (!type.startsWith('delegation.')) event.principal = { kind: 'human', id: 'owner' };
  if (type === 'member.joined') event.principal = { kind: 'human', id: subject.slice(7) };
  if (type === 'conversation.child_result_published') {
    event.source = 'opencrane-server';
    event.correlation = { request: privateText, conversation: privateText,
      turn: privateText, permit: privateText, approval: privateText };
  }
  const expectedSequence = await nats.store.head(subject);
  const saved = await nats.store.append({ event, expectedSequence });
  expect(saved.status, JSON.stringify(saved)).toBe('appended');
  if (['member.joined', 'conversation.created', 'member.removed'].includes(type)) {
    await auth.handler.handle(event, db);
  }
  return event;
}

async function setup() {
  logArguments = [];
  nats = await natsFixture();
  dbs = await databases();
  fga = await openfga();
  db = pgDb(dbs.queue);
  auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  runner = new ProjectionRunner(db, nats.store,
    createLogger('audit-child-publication-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(conversations);
  await runner.initialise(auditTrail);
  for (const memberId of ['owner', 'admin', 'reviewer', 'guest', 'child_reader']) {
    const role = memberId === 'owner' ? 'owner' : memberId === 'guest' ? 'member' : 'admin';
    await append(`member-${memberId}`, 'member.invited', {
      memberId, role, invitationId: `invite-${memberId}`, invitedBy: 'owner',
      email: `${memberId}@example.test`,
      invitedIdentity: { issuer: config.issuerUrl, sub: memberId },
      expiresAt: '2030-01-01T00:00:00Z',
    }, `invite-${memberId}`);
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, invitationId: `invite-${memberId}`,
      email: `${memberId}@example.test`, displayName: memberId,
      identity: { issuer: config.issuerUrl, sub: memberId },
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
    conversationId: 'child', createdBy: 'admin', mode: 'group',
    participantIds: ['admin', 'child_reader'],
  }, 'child-created');
  await runner.run(members);
  await runner.run(conversations);
  await runner.run(auditTrail);
  feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  expect(await feed.memberId('test', config.issuerUrl, 'owner')).toBe('owner');
  expect((await auth.check('owner', 'admin')).allowed).toBe(true);
  expect((await auth.check('admin', 'admin')).allowed).toBe(true);
  function unusedScan(): Promise<never> {
    return Promise.reject(new Error('The asset scanner must not start on a read'));
  }
  const shared = { silo: 'test', store: nats.store, db, feed, binding: auth.binding };
  const objects = new Client({ endPoint: '127.0.0.1' });
  app = buildServer(config, { audit: shared, files: { ...shared, objects, scan: unusedScan } });
  function captureErrors(request: FastifyRequest) {
    function recordError(...args: unknown[]) {
      logArguments.push(args);
    }
    vi.spyOn(request.log, 'error').mockImplementation(recordError);
    return Promise.resolve();
  }
  app.addHook('onRequest', captureErrors);
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
  const readers: [string, string, string][] = [
    ['owner', 'parent', 'child'], ['admin', 'child', 'parent'],
  ];
  for (const [memberId, visibleId, hiddenId] of readers) {
    const response = await list(memberId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(privateText);
    expect(response.body).toContain(visibleId);
    expect(response.body).not.toContain(`"${hiddenId}"`);
    const page = auditResponseSchema.parse(response.json());
    expect(page.rows.filter(row => row.id === 'publication')).toHaveLength(1);
    expect(page.rows[0]?.requestId).toBeUndefined();
    expect(page.rows[0]?.permitId).toBeUndefined();
    const shown = await detail(memberId, 'publication');
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.body).not.toContain(privateText);
    expect(shown.body).toContain(visibleId);
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
  expect((await auth.conversation('owner', 'child', 'read')).allowed).toBe(false);
  const childHistory = await app.inject({ url: '/api/conversations/child/history',
    headers: headers('owner') });
  expect(childHistory.statusCode).toBe(403);
  const childAsset = await app.inject({
    url: '/api/conversations/child/files/view?path=uploads/child/file/report.txt',
    headers: headers('owner'),
  });
  expect(childAsset.statusCode).toBe(403);
  expect(childAsset.body).not.toContain(privateText);
  const restricted = await detail('reviewer', 'publication');
  expect(restricted.statusCode).toBe(200);
  const stub = auditDetailSchema.parse(restricted.json()).records[0]!;
  expect(stub.parentConversationId).toBeUndefined();
  expect(stub.childConversationId).toBeUndefined();
  expect(stub.resultEventId).toBeUndefined();
  expect(stub.publicationKind).toBeUndefined();
  expect(stub.actor).toBeUndefined();
  expect(stub.taskHref).toBeUndefined();
  expect(JSON.stringify(logArguments)).not.toContain(privateText);
  expect(await nats.store.head()).toBe(before);
  expect(appends).not.toHaveBeenCalled();
});

it('keeps a child publication out of a parent reader’s matching turn', async () => {
  await publish('publication');
  await append('decision-parent', 'decision.recorded', {
    requestId: 'parent-request', requesterId: 'guest', conversationId: 'parent',
    turnId: 'turn', route: 'mcp', outcome: 'allow', reason: 'policy_allow',
    contextDigest: '0'.repeat(64),
  }, 'parent-decision');
  await runner.run(auditTrail);
  expect((await auth.conversation('guest', 'parent', 'read')).allowed).toBe(true);
  expect((await auth.conversation('guest', 'child', 'read')).allowed).toBe(false);

  const projected = await readAudit(db, 'test', {
    conversationId: 'parent', requesterId: 'guest',
  });
  const decision = projected.rows.find(row => row.id === 'parent-decision');
  expect(decision).toBeDefined();
  expect(decision?.records.map(record => record.eventId)).toEqual(['parent-decision']);
  const publication = await readAuditDetail(db, 'test', 'publication', { limit: 1 });
  expect(publication?.records.map(record => record.eventId)).toEqual(['publication']);
  expect(publication?.nextBefore).toBeUndefined();
  const publicationContinuation = await readAuditDetail(db, 'test', 'publication', {
    before: publication!.records[0]!.position, limit: 1,
  });
  expect(publicationContinuation?.records).toEqual([]);

  const history = await app.inject({ url: '/api/conversations/parent/history',
    headers: headers('guest') });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.body).not.toContain('child');
  const page = auditResponseSchema.parse(history.json());
  expect(page.rows.find(row => row.id === 'parent-decision')?.records)
    .toHaveLength(1);

  const detailResponse = await detail('owner', 'parent-decision');
  expect(detailResponse.statusCode, detailResponse.body).toBe(200);
  const detailPage = auditDetailSchema.parse(detailResponse.json());
  expect(detailPage.records.map(record => record.eventId)).toEqual(['parent-decision']);
});

it('hides child references when a publication reaches parent conversation history', async () => {
  await publish('publication');
  // Model an older projection that linked the publication to the parent reader.
  await db.query(`UPDATE audit_entries SET requester_id = $1
    WHERE silo = $2 AND event_id = $3`, ['guest', 'test', 'publication']);
  const projected = await readAudit(db, 'test', {
    conversationId: 'parent', requesterId: 'guest',
  });
  expect(projected.rows).toHaveLength(1);
  expect(projected.rows[0]?.records[0]).toMatchObject({
    childConversationId: 'child', resultEventId: 'child-result',
  });
  expect((await auth.conversation('guest', 'parent', 'read')).allowed).toBe(true);
  expect((await auth.conversation('guest', 'child', 'read')).allowed).toBe(false);

  const response = await app.inject({
    url: '/api/conversations/parent/history', headers: headers('guest'),
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).not.toContain('"childConversationId":"child"');
  expect(response.body).not.toContain('child-result');
  const page = auditResponseSchema.parse(response.json());
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]?.id).toBe('publication');
  expect(page.rows[0]?.records[0]).toMatchObject({ parentConversationId: 'parent' });
  expect(page.rows[0]?.records[0]?.childConversationId).toBeUndefined();
  expect(page.rows[0]?.records[0]?.resultEventId).toBeUndefined();
});

it('returns a fixed error and logs no private publication text after a failed read', async () => {
  await publish('publication');
  vi.spyOn(db, 'query').mockRejectedValueOnce(new Error(privateText));
  const response = await list('owner');
  expect(response.statusCode).toBe(503);
  expect(response.body).toBe('{"status":"unavailable"}');
  expect(JSON.stringify(logArguments)).not.toContain(privateText);
});

it('rejects altered publication sources and payloads without logging private text', async () => {
  await publish('publication');
  const saved = (await nats.store.readEvent(await nats.store.head())).event;
  const publicationData = z.record(z.string(), z.unknown()).parse(saved.data);
  const invalidEvents: EventEnvelope[] = [
    { ...saved, source: 'other' },
    { ...saved, subject: 'conversation-child' },
    { ...saved, principal: { kind: 'human', id: 'admin' } },
    { ...saved, data: { ...publicationData, publishedBy: 'admin' } },
    { ...saved, data: { ...publicationData, publicationKind: 'unknown' } },
  ];
  for (const event of invalidEvents) {
    await expect(auditTrail.apply(db, event, 999))
      .rejects.toThrow('Invalid publication audit event');
  }
  expect(JSON.stringify(logArguments)).not.toContain(privateText);
  const history = await list('owner');
  expect(history.statusCode, history.body).toBe(200);
  expect(auditResponseSchema.parse(history.json()).rows).toHaveLength(1);
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

async function delegation(id: string, conversationId: string, parentDelegationId?: string) {
  const data = { ...modernDelegationExample, delegationId: id, conversationId,
    rootId: 'private-root', assistantId: 'private-assistant',
    parentDelegationId, turnId: `${id}-turn`, threadId: `${id}-thread`,
    computerAdmission: { eventId: `${id}-admission`, position: 2 } };
  await append(`delegation-${id}`, 'delegation.started', data, `${id}-start`);
}

async function finishDelegation(id: string, outcome: 'completed' | 'failed' | 'cancelled') {
  const data = { version: 1, delegationId: id, outcome,
    terminalEvidence: { eventId: `${id}-terminal`, position: 3 },
    resultReference: { eventId: `${id}-private-result`, position: 4 } };
  await append(`delegation-${id}`, 'delegation.completed', data, `${id}-outcome`);
  await runner.run(auditTrail);
}

it('keeps execution and unresolved money separate across terminal outcomes', async () => {
  await delegation('parent-task', 'parent');
  await delegation('child-task', 'child', 'parent-task');
  await finishDelegation('child-task', 'completed');
  const first = await list('admin', '?type=delegation');
  expect(first.statusCode, first.body).toBe(200);
  const completed = auditResponseSchema.parse(first.json()).rows[0]!.records[0]!;
  expect(completed).toMatchObject({ executionOutcome: 'completed', moneyStatus: 'unavailable',
    joinStatus: 'current', delegationId: 'child-task', taskHref: '/workspace?conversation=child' });
  expect(first.body).not.toContain(privateText);
  expect(first.body).not.toContain('private-result');
  for (const [id, outcome] of [['failed-task', 'failed'], ['stopped-task', 'cancelled']] as const) {
    await delegation(id, 'child');
    await finishDelegation(id, outcome);
    const response = await detail('admin', `${id}-outcome`);
    const record = auditDetailSchema.parse(response.json()).records[0]!;
    expect(record.executionOutcome).toBe(outcome);
    expect(record.moneyStatus).toBe('unavailable');
  }
});

it('shows one neutral child placeholder unless its own conversation is readable', async () => {
  await delegation('parent-task', 'parent');
  await delegation('child-task', 'child', 'parent-task');
  await finishDelegation('child-task', 'failed');
  const parentOnly = await detail('owner', 'child-task-outcome');
  const parentRecord = auditDetailSchema.parse(parentOnly.json()).records[0]!;
  expect(parentRecord.delegationAccess).toBe('restricted');
  expect(parentOnly.body).not.toContain('"delegationId":"child-task"');
  expect(parentOnly.body).not.toContain('private-assistant');
  const childOnly = await detail('admin', 'child-task-outcome');
  const childRecord = auditDetailSchema.parse(childOnly.json()).records[0]!;
  expect(childRecord.delegationId).toBe('child-task');
  expect(childRecord.parentDelegationId).toBeUndefined();
  expect(childRecord.rootId).toBeUndefined();
  expect(childRecord.taskHref).toBe('/workspace?conversation=child');
  const neither = await detail('reviewer', 'child-task-outcome');
  const neitherRecord = auditDetailSchema.parse(neither.json()).records[0]!;
  expect(neitherRecord.delegationAccess).toBe('restricted');
  expect(neither.body).not.toContain('"delegationId":"child-task"');
});

it('keeps missing delegation joins unavailable and two equal-time outcomes stable', async () => {
  await finishDelegation('orphan', 'completed');
  await delegation('parent-task', 'parent');
  await delegation('child-task', 'child', 'parent-task');
  await finishDelegation('child-task', 'cancelled');
  const first = await list('admin', '?type=delegation&limit=1');
  const page = auditResponseSchema.parse(first.json());
  const second = await list('admin', `?type=delegation&limit=1&before=${page.nextBefore}`);
  expect(new Set([...page.rows, ...auditResponseSchema.parse(second.json()).rows]
    .map(row => row.id)).size).toBe(2);
  const orphan = await detail('admin', 'orphan-outcome');
  const record = auditDetailSchema.parse(orphan.json()).records[0]!;
  expect(record.joinStatus).toBe('unavailable');
  expect(record.taskHref).toBeUndefined();
});

it('deduplicates delegation delivery and replays without work or extra appends', async () => {
  await delegation('child-task', 'child');
  await finishDelegation('child-task', 'completed');
  const saved = (await nats.store.readEvent(await nats.store.head())).event;
  await auditTrail.apply(db, saved, await nats.store.head());
  const before = await list('admin', '?type=delegation');
  expect(auditResponseSchema.parse(before.json()).rows).toHaveLength(1);
  const appendSpy = vi.spyOn(nats.store, 'append');
  await rebuildAuditProjection(db, nats.store,
    createLogger('delegation-replay', { level: 'silent' }), { verify: true });
  expect((await list('admin', '?type=delegation')).json()).toEqual(before.json());
  expect(appendSpy).not.toHaveBeenCalled();
});
