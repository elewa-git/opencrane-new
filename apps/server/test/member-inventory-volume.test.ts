import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import type { EventEnvelope } from '@opencrane/events';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversations, members, computers, pgDb, ProjectionRunner,
  type Query } from '@opencrane/projections';
import { memberDepartureSchema } from '@opencrane/protocol';
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

async function append(subject: string, type: string, data: unknown) {
  const record = { ...event(`volume-${++counter}`, subject, type), silo: 'acme', data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}

async function project() {
  for (const projection of [members, conversations, computers]) {
    await runner.run(projection);
  }
}

function request() {
  const session = { sub: 'owner', orgId: 'org-acme', roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: '/api/members/bob/departure', headers });
}

async function readDeparture() {
  const response = await request();
  expect(response.statusCode, response.body).toBe(200);
  const body: unknown = response.json();
  return memberDepartureSchema.parse(body);
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('inventory-volume-test'));
  for (const projection of [members, conversations, computers]) {
    await runner.initialise(projection);
  }
  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member']]) {
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

async function projectVolumeFixtures(records: EventEnvelope[], firstPosition: number) {
  const db = pgDb(dbs.queue);
  function eventId(record: EventEnvelope) {
    return record.id;
  }
  const eventIds = records.map(eventId);
  const lastPosition = firstPosition + records.length - 1;
  for (const projection of [members, conversations, computers]) {
    async function applyRecords(transaction: Query) {
      const checkpoint = await transaction.query<{ sequence: string }>(
        'SELECT sequence FROM projection_checkpoints WHERE name = $1', [projection.name]);
      expect(Number(checkpoint.rows[0]?.sequence)).toBe(firstPosition - 1);
      // Apply these fixtures together so cleanup does not commit every unrelated read receipt.
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) {
          throw new Error('Volume fixture missing');
        }
        await projection.apply(transaction, record, firstPosition + index);
      }
      await transaction.query(`INSERT INTO projection_events
        SELECT $1, event_id FROM unnest($2::text[]) AS event_id`, [projection.name, eventIds]);
      await transaction.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1',
        [projection.name, lastPosition]);
    }
    await db.transaction(applyRecords);
  }
}

async function ignoresLargeUnrelatedHistoryTail() {
  const creation = await append('conversation-unrelated-volume', 'conversation.created', {
    conversationId: 'unrelated-volume', assistantId: 'unrelated-volume',
    createdBy: 'someone-else',
  });
  const message = await append('conversation-unrelated-volume', 'message.posted', {
    conversationId: 'unrelated-volume', authorId: 'someone-else', authorKind: 'human',
    ciphertext: Buffer.from('Unrelated volume fixture').toString('base64'),
    keyId: 'key:unrelated-volume', contentType: 'text',
  });
  const messagePosition = await nats.store.head('conversation-unrelated-volume');
  await project();
  const before = await readDeparture();
  expect(before).toMatchObject({ complete: true, accessLost: [], retainedHistory: { count: 0 } });
  const records = [];
  for (let index = 0; index < 10_001; index++) {
    const data = { conversationId: 'unrelated-volume', memberId: 'someone-else',
      joinEventId: creation.id, throughPosition: messagePosition, throughEventId: message.id };
    const record = { ...event(`volume-${++counter}`, 'chat-state-someone-else',
      'conversation.read_advanced'), silo: 'acme',
      principal: { kind: 'human' as const, id: 'someone-else' }, data };
    records.push(record);
  }
  const firstPosition = await nats.store.head() + 1;
  await nats.seed(records);
  const globalReads = vi.spyOn(nats.store, 'readEvent');
  try {
    const started = performance.now();
    const response = await request();
    expect(response.statusCode, response.body).toBe(200);
    expect(performance.now() - started).toBeLessThan(2_000);
    const pending = memberDepartureSchema.parse(response.json());
    expect(pending.accessLost).toEqual([]);
    if (pending.complete) {
      expect(pending.retainedHistory).toEqual(before.retainedHistory);
      expect(pending.reviewRevision).toBe(before.reviewRevision);
    } else {
      expect(pending.permissions.remove).toBe(false);
      expect(pending.unavailableSections.length).toBeGreaterThan(0);
    }
    expect(globalReads).not.toHaveBeenCalled();
  } finally {
    globalReads.mockRestore();
    await projectVolumeFixtures(records, firstPosition);
  }
  const after = await readDeparture();
  expect(after).toMatchObject({ complete: true, accessLost: [], retainedHistory: { count: 0 } });
  expect(after.reviewRevision).toBe(before.reviewRevision);
}
it('returns a bounded review after 10,001 unrelated pending history events',
  ignoresLargeUnrelatedHistoryTail, 120_000);

