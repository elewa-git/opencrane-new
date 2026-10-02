import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { encodeSession, type SessionData } from '@opencrane/auth';
import { connectEventStore, type StoredEvent } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { JoinResult, JoinStore } from '../src/members/join.ts';
import { testAuthConfig, tamperCookie } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let clock = new Date('2026-10-01T12:00:00Z');
const session: SessionData = {
  sub: 'idp-alice', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
};
const input = { memberId: 'alice', invitationId: 'invite-alice', commandId: 'join-alice', displayName: 'Alice' };
let nats: Awaited<ReturnType<typeof natsFixture>>;
let app: FastifyInstance;

beforeEach(async () => {
  clock = new Date('2026-10-01T12:00:00Z');
  nats = await natsFixture();
  app = server(nats.store);
});
afterEach(async () => {
  await app.close();
  await nats.close();
});

function server(store: JoinStore) {
  return buildServer(config, { membership: { silo: 'acme', store, now: () => clock } });
}
function accept(body: unknown = input, identity: SessionData = session) {
  return app.inject({ method: 'POST', url: '/members/join', payload: JSON.stringify(body), headers: {
    'content-type': 'application/json', origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, identity)}`,
  } });
}
function invitation(patch: Record<string, unknown> = {}, silo = 'acme') {
  return {
    ...event(randomUUID(), 'member-alice', 'member.invited'), silo,
    data: { memberId: 'alice', invitationId: 'invite-alice', email: 'alice@example.test', role: 'admin',
      invitedBy: 'admin', invitedIdentity: { issuer: config.issuerUrl, sub: session.sub },
      expiresAt: '2026-10-02T12:00:00Z', ...patch },
  };
}
async function invite(patch: Record<string, unknown> = {}, silo = 'acme') {
  const result = await nats.store.append({ event: invitation(patch, silo), expectedSequence: 0 });
  expect(result.status).toBe('appended');
}
async function history() {
  const records: StoredEvent[] = [];
  for await (const stored of nats.store.readStream('member-alice')) records.push(stored);
  return records;
}

it.skipIf(!process.env['PG_TEST_URL'])('accepts through real NATS to PostgreSQL 17, restarts and rebuilds the members projection', async () => {
  const schema = `join_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env['PG_TEST_URL'] });
  let pool: Pool | undefined;
  try {
    expect((await admin.query<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version).toMatch(/^17\./u);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const open = () => new Pool({ connectionString: process.env['PG_TEST_URL'], options: `-c search_path=${schema}` });
    pool = open();
    let runner = new ProjectionRunner(pgDb(pool), nats.reader, createLogger('test'));
    await runner.initialise(members);
    await invite();
    await runner.run(members);
    expect((await pool.query('SELECT status FROM members')).rows).toEqual([{ status: 'invited' }]);
    const append = vi.spyOn(nats.store, 'append');
    const response = await accept();
    expect(response.statusCode).toBe(200);
    expect(response.json<JoinResult>()).toEqual({ status: 'joined', memberId: 'alice', sequence: 2 });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0].expectedSequence).toBe(1);
    // The command has no database handle; the row changes only when the listener runs.
    expect((await pool.query('SELECT status FROM members')).rows).toEqual([{ status: 'invited' }]);
    await runner.run(members);
    const expected = [{ silo: 'acme', member_id: 'alice', email: 'alice@example.test',
      display_name: 'Alice', role: 'admin', status: 'joined' }];
    expect((await pool.query('SELECT * FROM members')).rows).toEqual(expected);
    await pool.end();
    pool = open();
    runner = new ProjectionRunner(pgDb(pool), nats.reader, createLogger('test'));
    expect(await runner.checkpoint(members)).toBe(2);
    await runner.rebuild(members);
    expect((await pool.query('SELECT * FROM members')).rows).toEqual(expected);
    expect((await pool.query('SELECT * FROM projection_events')).rows).toHaveLength(2);
    const stored = await history();
    expect(stored).toHaveLength(2);
    expect(stored[1]?.event).toMatchObject({ commandId: input.commandId, silo: 'acme',
      principal: { id: session.sub, kind: 'human' }, subject: 'member-alice',
      data: { invitationId: input.invitationId, role: 'admin', email: 'alice@example.test' } });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

it('recognises the same command after NATS restart and invitation expiry without another append', async () => {
  await invite();
  expect((await accept()).json<JoinResult>().status).toBe('joined');
  await nats.stop();
  await nats.restart();
  clock = new Date('2026-10-03T12:00:00Z');
  const append = vi.spyOn(nats.store, 'append');
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'already_joined', memberId: 'alice', sequence: 2 });
  expect(append).not.toHaveBeenCalled();
  expect(await history()).toHaveLength(2);
});

// Both requests finish reading the same pending invitation before either publishes.
function racingStore(): JoinStore {
  let reads = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {
    append: (command) => nats.store.append(command),
    async *readStream(subject, from, deadline) {
      const events: StoredEvent[] = [];
      for await (const stored of nats.store.readStream(subject, from, deadline)) events.push(stored);
      reads += 1;
      if (reads === 2) release();
      if (reads <= 2) await barrier;
      yield* events;
    },
  };
}
it.each([false, true])('concurrent accepts have exactly one durable winner (same command: %s)', async (sameCommand) => {
  await invite();
  await app.close();
  app = server(racingStore());
  const responses = await Promise.all([accept(), accept({ ...input, commandId: sameCommand ? input.commandId : 'second' })]);
  expect(responses.map((response) => response.json<JoinResult>().status).sort())
    .toEqual(sameCommand ? ['already_joined', 'joined'] : ['joined', 'refused']);
  expect(await history()).toHaveLength(2);
  expect(await nats.store.head()).toBe(2);
});

it.each([
  { name: 'wrong identity', identity: { ...session, sub: 'mallory' }, patch: {}, silo: 'acme', reason: 'wrong_identity' },
  { name: 'wrong issuer', identity: session, patch: { invitedIdentity: { issuer: 'https://other.test', sub: session.sub } }, silo: 'acme', reason: 'wrong_identity' },
  { name: 'other session organisation', identity: { ...session, orgId: 'org-other' }, patch: {}, silo: 'acme', reason: 'wrong_silo' },
  { name: 'other event silo', identity: session, patch: {}, silo: 'other', reason: 'wrong_silo' },
  { name: 'unknown invitation', identity: session, patch: { invitationId: 'another' }, silo: 'acme', reason: 'unknown_invitation' },
  { name: 'expired invitation at exact boundary', identity: session, patch: { expiresAt: '2026-10-01T12:00:00Z' }, silo: 'acme', reason: 'expired_invitation' },
  { name: 'legacy unbound invitation', identity: session, patch: { invitedIdentity: undefined }, silo: 'acme', reason: 'unbound_invitation' },
  { name: 'legacy invitation without expiry', identity: session, patch: { expiresAt: undefined }, silo: 'acme', reason: 'unbound_invitation' },
])('refuses $name without appending', async ({ identity, patch, silo, reason }) => {
  await invite(patch, silo);
  const append = vi.spyOn(nats.store, 'append');
  expect((await accept(input, identity)).json<JoinResult>()).toEqual({ status: 'refused', reason });
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(1);
});

it('refuses a member stream that does not exist without appending', async () => {
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'refused', reason: 'unknown_invitation' });
  expect(await nats.store.head()).toBe(0);
});

it('refuses inconsistent member ids in stored history', async () => {
  await invite({ memberId: 'someone-else' });
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'refused', reason: 'invalid_history' });
  expect(await nats.store.head()).toBe(1);
});

it.each(['store', 'organisation'])('fails closed without the configured %s', async (missing) => {
  await invite();
  await app.close();
  if (missing === 'store') app = buildServer(config);
  else {
    const { expectedOrgId: _omitted, ...unpinned } = config;
    app = buildServer(unpinned, { membership: { silo: 'acme', store: nats.store, now: () => clock } });
  }
  const response = await accept();
  expect(response.statusCode).toBe(503);
  expect(response.json<JoinResult>()).toEqual({ status: 'unavailable' });
  expect(await nats.store.head()).toBe(1);
});

it('does not recognise another identity or issuer as the successful command principal', async () => {
  await invite();
  await accept();
  expect((await accept(input, { ...session, sub: 'mallory' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'wrong_identity' });
  await app.close();
  const otherIssuer = { ...config, issuerUrl: 'https://other.example.test' };
  app = buildServer(otherIssuer, { membership: { silo: 'acme', store: nats.store, now: () => clock } });
  const response = await app.inject({ method: 'POST', url: '/members/join', payload: input,
    headers: { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(otherIssuer, session)}` } });
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'wrong_identity' });
  expect(await nats.store.head()).toBe(2);
});

it.each(['missing', 'tampered', 'expired'])('refuses a %s session without appending', async (kind) => {
  await invite();
  const cookie = kind === 'expired' ? encodeSession(config, { ...session, exp: clock.getTime() / 1000 })
    : tamperCookie(encodeSession(config, session));
  const response = await app.inject({ method: 'POST', url: '/members/join', payload: input,
    headers: { origin: 'https://app.example.test', ...(kind === 'missing' ? {} : { cookie: `${config.cookieName}=${cookie}` }) } });
  expect(response.statusCode).toBe(401);
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'no_session' });
  expect(await nats.store.head()).toBe(1);
});

it('refuses command-id reuse with changed arguments, a second acceptance, and acceptance after removal', async () => {
  await invite();
  await accept();
  expect((await accept({ ...input, displayName: 'Different' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'command_id_reused' });
  expect((await accept({ ...input, commandId: 'second' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'invitation_not_pending' });
  await nats.store.append({ expectedSequence: 2, event: { ...event('removed', 'member-alice', 'member.removed'), silo: 'acme' } });
  expect((await accept({ ...input, commandId: 'third' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'invitation_not_pending' });
  expect((await accept()).json<JoinResult>().status).toBe('already_joined');
  expect(await nats.store.head()).toBe(3);
});

it.each([{ ...input, role: 'owner' }, { ...input, memberId: '*' }, { ...input, silo: 'other' }, { ...input, commandId: '' }])(
  'rejects invalid input %j without appending', async (body) => {
    await invite();
    expect((await accept(body)).json<JoinResult>()).toEqual({ status: 'refused', reason: 'invalid_request' });
    expect(await nats.store.head()).toBe(1);
  },
);
it.each([undefined, 'https://evil.example.test'])('refuses origin %s', async (origin) => {
  await invite();
  const response = await app.inject({ method: 'POST', url: '/members/join', payload: input,
    headers: { cookie: `${config.cookieName}=${encodeSession(config, session)}`, ...(origin ? { origin } : {}) } });
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'wrong_origin' });
  expect(await nats.store.head()).toBe(1);
});

it('reports unavailable when real NATS cannot be read, then safely retries', async () => {
  await invite();
  await nats.stop();
  const response = await accept();
  expect(response.statusCode).toBe(503);
  expect(response.json<JoinResult>()).toEqual({ status: 'unavailable' });
  await nats.restart();
  expect(await nats.store.head()).toBe(1);
  expect((await accept()).json<JoinResult>().status).toBe('joined');
});

it('reports unavailable if NATS stops after validation and before append, with no secret in the result', async () => {
  await invite();
  await app.close();
  app = server({
    readStream: (...args) => nats.store.readStream(...args),
    async append(command) {
      await nats.stop();
      return nats.store.append(command);
    },
  });
  const response = await accept();
  expect(response.statusCode).toBe(503);
  expect(response.json<JoinResult>()).toEqual({ status: 'unavailable' });
  await nats.restart();
  expect(await nats.store.head()).toBe(1);
// EventStore still stops retrying after ten seconds. This limit also covers
// stopping and restarting the real NATS process on a busy machine.
}, 45_000);

it('uses the process connection adapter against real NATS', async () => {
  const connected = await connectEventStore(nats.env());
  try {
    await app.close();
    app = server(connected.store);
    await invite();
    expect((await accept()).json<JoinResult>().status).toBe('joined');
    expect(await nats.store.head()).toBe(2);
  } finally {
    await connected.close();
  }
});
