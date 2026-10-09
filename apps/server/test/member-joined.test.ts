import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { databases } from '@opencrane/authz/testing';
import { encodeSession, type SessionData } from '@opencrane/auth';
import { connectEventStore, type StoredEvent } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { JoinResult, JoinStore } from '../src/members/join.ts';
import { testAuthConfig, tamperCookie } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme',
  extraIdentities: [{ issuer: 'https://idp.example.test', subject: 'idp-owner' }] });
let clock = new Date('2026-10-01T12:00:00Z');
const session: SessionData = {
  email: 'alice@example.test', emailVerified: true,
  sub: 'idp-alice', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
};
const input = { memberId: 'alice', invitationId: 'invite-alice', commandId: 'join-alice', displayName: 'Alice' };
let nats: Awaited<ReturnType<typeof natsFixture>>;
let app: FastifyInstance;
let dbs: Awaited<ReturnType<typeof databases>>;

async function openAcceptanceDatabase() {
  dbs = await databases();
}
async function closeAcceptanceDatabase() {
  await dbs?.close();
}
beforeAll(openAcceptanceDatabase, 120_000);
afterAll(closeAcceptanceDatabase);

beforeEach(async () => {
  clock = new Date('2026-10-01T12:00:00Z');
  nats = await natsFixture();
  await seedInviter();
  const db = pgDb(dbs.queue);
  await members.drop(db);
  const runner = new ProjectionRunner(db, nats.reader, createLogger('test'));
  await runner.initialise(members);
  await db.query("UPDATE projection_checkpoints SET sequence = 0 WHERE name = 'members'");
  await db.query("DELETE FROM projection_events WHERE projection = 'members'");
  await runner.run(members);
  app = server(nats.store);
});
afterEach(async () => {
  await app.close();
  await nats.close();
});

function server(store: JoinStore) {
  return buildServer(config, { membership: { silo: 'acme', store, db: pgDb(dbs.queue), now: () => clock } });
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

const assistantChoices = ['none', 'provision', undefined] as const;
async function carriesAssistantChoice(choice: typeof assistantChoices[number]) {
  await invite({ personalAssistant: choice });
  const response = await accept();
  expect(response.statusCode).toBe(200);
  expect(response.json<JoinResult>().status).toBe('joined');
  const records = await history();
  expect(records).toHaveLength(2);
  expect(records[1]?.event.data).toMatchObject({
    memberId: 'alice', personalAssistant: choice ?? 'provision',
  });
  expect((await accept()).json<JoinResult>().status).toBe('already_joined');
  expect(await history()).toEqual(records);
}
it.each(assistantChoices)('stores the invitation assistant choice (%s) in one join',
  carriesAssistantChoice);

async function refusesAssistantOverride() {
  await invite({ personalAssistant: 'none' });
  const body = { ...input, personalAssistant: 'provision' };
  const response = await accept(body);
  expect(response.statusCode).toBe(400);
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'invalid_request' });
  expect(await history()).toHaveLength(1);
}
it('refuses an assistant choice supplied by the accepting person', refusesAssistantOverride);

async function keepsChoiceAfterLostReply() {
  await invite({ personalAssistant: 'none' });
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    expect(result.status).toBe('appended');
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  const transport = {
    head: nats.store.head.bind(nats.store),
    readStream: nats.store.readStream.bind(nats.store),
    append: loseReply,
  };
  await app.close();
  app = server(transport);
  expect((await accept()).statusCode).toBe(503);
  const saved = await history();
  expect(saved).toHaveLength(2);
  expect(saved[1]?.event.data).toMatchObject({ personalAssistant: 'none' });
  await app.close();
  await nats.stop();
  await nats.restart();
  app = server(nats.store);
  expect((await accept()).json<JoinResult>()).toEqual({
    status: 'already_joined', memberId: 'alice', sequence: saved[1]?.sequence,
  });
  expect(await history()).toEqual(saved);
}
it('keeps the saved assistant choice after a lost join reply and restart', keepsChoiceAfterLostReply);

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
    expect((await pool.query('SELECT status FROM members WHERE member_id = \'alice\'')).rows).toEqual([{ status: 'invited' }]);
    const append = vi.spyOn(nats.store, 'append');
    const response = await accept();
    expect(response.statusCode).toBe(200);
    expect(response.json<JoinResult>()).toEqual({ status: 'joined', memberId: 'alice', sequence: 3 });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0].expectedSequence).toBe(2);
    // Leave writes to the background worker; acceptance only reads the database.
    expect((await pool.query('SELECT status FROM members WHERE member_id = \'alice\'')).rows).toEqual([{ status: 'invited' }]);
    await runner.run(members);
    const expected = [{ silo: 'acme', member_id: 'alice', email: 'alice@example.test',
      display_name: 'Alice', role: 'admin', status: 'joined' }];
    expect((await pool.query('SELECT * FROM members WHERE member_id = \'alice\'')).rows).toEqual(expected);
    await pool.end();
    pool = open();
    runner = new ProjectionRunner(pgDb(pool), nats.reader, createLogger('test'));
    expect(await runner.checkpoint(members)).toBe(3);
    await runner.rebuild(members);
    expect((await pool.query('SELECT * FROM members WHERE member_id = \'alice\'')).rows).toEqual(expected);
    expect((await pool.query('SELECT * FROM projection_events')).rows).toHaveLength(3);
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
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'already_joined', memberId: 'alice', sequence: 3 });
  expect(append).not.toHaveBeenCalled();
  expect(await history()).toHaveLength(2);
});

it('refuses an allowlisted identity from another organisation for membership', async () => {
  const external = { ...session, sub: 'idp-owner', orgId: 'org-other' };
  await invite({ invitedIdentity: { issuer: config.issuerUrl, sub: external.sub } });
  expect((await accept(input, external)).json<JoinResult>()).toEqual({ status: 'refused', reason: 'wrong_silo' });
  expect(await history()).toHaveLength(1);
});

// Both requests finish reading the same pending invitation before either publishes.
function racingStore(): JoinStore {
  let reads = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  return {
    head: nats.store.head.bind(nats.store),
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
  expect(await nats.store.head()).toBe(3);
});

it.each([
  { name: 'wrong identity', identity: { ...session, sub: 'mallory' }, patch: {}, silo: 'acme', reason: 'wrong_identity' },
  { name: 'wrong issuer', identity: session, patch: { invitedIdentity: { issuer: 'https://other.test', sub: session.sub } }, silo: 'acme', reason: 'wrong_identity' },
  { name: 'other session organisation', identity: { ...session, orgId: 'org-other' }, patch: {}, silo: 'acme', reason: 'wrong_silo' },
  { name: 'other event silo', identity: session, patch: {}, silo: 'other', reason: 'wrong_silo' },
  { name: 'unknown invitation', identity: session, patch: { invitationId: 'another' }, silo: 'acme', reason: 'unknown_invitation' },
  { name: 'expired invitation at exact boundary', identity: session, patch: { expiresAt: '2026-10-01T12:00:00Z' }, silo: 'acme', reason: 'expired_invitation' },
  { name: 'legacy invitation without expiry', identity: session, patch: { expiresAt: undefined }, silo: 'acme', reason: 'unbound_invitation' },
])('refuses $name without appending', async ({ identity, patch, silo, reason }) => {
  await invite(patch, silo);
  const append = vi.spyOn(nats.store, 'append');
  expect((await accept(input, identity)).json<JoinResult>()).toEqual({ status: 'refused', reason });
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(2);
});

it('refuses a member stream that does not exist without appending', async () => {
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'refused', reason: 'unknown_invitation' });
  expect(await nats.store.head()).toBe(1);
});

it('refuses inconsistent member ids in stored history', async () => {
  await invite({ memberId: 'someone-else' });
  expect((await accept()).json<JoinResult>()).toEqual({ status: 'refused', reason: 'invalid_history' });
  expect(await nats.store.head()).toBe(2);
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
  expect(await nats.store.head()).toBe(2);
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
  expect(await nats.store.head()).toBe(3);
});

it.each(['missing', 'tampered', 'expired'])('refuses a %s session without appending', async (kind) => {
  await invite();
  const cookie = kind === 'expired' ? encodeSession(config, { ...session, exp: clock.getTime() / 1000 })
    : tamperCookie(encodeSession(config, session));
  const response = await app.inject({ method: 'POST', url: '/members/join', payload: input,
    headers: { origin: 'https://app.example.test', ...(kind === 'missing' ? {} : { cookie: `${config.cookieName}=${cookie}` }) } });
  expect(response.statusCode).toBe(401);
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'no_session' });
  expect(await nats.store.head()).toBe(2);
});

it('refuses command-id reuse with changed arguments, a second acceptance, and acceptance after removal', async () => {
  await invite();
  await accept();
  expect((await accept({ ...input, displayName: 'Different' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'command_id_reused' });
  expect((await accept({ ...input, commandId: 'second' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'invitation_not_pending' });
  await nats.store.append({ expectedSequence: 3, event: { ...event('removed', 'member-alice', 'member.removed'), silo: 'acme' } });
  expect((await accept({ ...input, commandId: 'third' })).json<JoinResult>())
    .toEqual({ status: 'refused', reason: 'access_removed' });
  const replay = await accept();
  expect(replay.statusCode).toBe(403);
  expect(replay.json()).toEqual({ status: 'refused', reason: 'access_removed' });
  expect(await nats.store.head()).toBe(4);
});

it.each([{ ...input, role: 'owner' }, { ...input, memberId: '*' }, { ...input, silo: 'other' }, { ...input, commandId: '' }])(
  'rejects invalid input %j without appending', async (body) => {
    await invite();
    expect((await accept(body)).json<JoinResult>()).toEqual({ status: 'refused', reason: 'invalid_request' });
    expect(await nats.store.head()).toBe(2);
  },
);
it.each([undefined, 'https://evil.example.test'])('refuses origin %s', async (origin) => {
  await invite();
  const response = await app.inject({ method: 'POST', url: '/members/join', payload: input,
    headers: { cookie: `${config.cookieName}=${encodeSession(config, session)}`, ...(origin ? { origin } : {}) } });
  expect(response.json<JoinResult>()).toEqual({ status: 'refused', reason: 'wrong_origin' });
  expect(await nats.store.head()).toBe(2);
});

it('reports unavailable when real NATS cannot be read, then safely retries', async () => {
  await invite();
  await nats.stop();
  const response = await accept();
  expect(response.statusCode).toBe(503);
  expect(response.json<JoinResult>()).toEqual({ status: 'unavailable' });
  await nats.restart();
  expect(await nats.store.head()).toBe(2);
  expect((await accept()).json<JoinResult>().status).toBe('joined');
});

it('reports unavailable if NATS stops after validation and before append, with no secret in the result', async () => {
  await invite();
  await app.close();
  app = server({
    head: nats.store.head.bind(nats.store),
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
  expect(await nats.store.head()).toBe(2);
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
    expect(await nats.store.head()).toBe(3);
  } finally {
    await connected.close();
  }
});


const emailRefusals = [
  { name: 'unverified email', identity: { ...session, emailVerified: false } },
  { name: 'missing verified email', identity: { ...session, emailVerified: undefined } },
  { name: 'different email', identity: { ...session, email: 'other@example.test' } },
  { name: 'forwarded link with another account', identity: { ...session, sub: 'other' } },
];
async function emailRefusal({ identity }: { identity: SessionData }) {
  await invite();
  const response = await accept(input, identity);
  const reason = identity.emailVerified === undefined ? 'sign_in_again' : 'wrong_identity';
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await history()).toHaveLength(1);
}
it.each(emailRefusals)('refuses $name and saves no join', emailRefusal);

async function matchingEmail() {
  await invite();
  const identity = { ...session, email: ' ALICE@Example.test ' };
  expect((await accept(input, identity)).json()).toMatchObject({ status: 'joined' });
  expect(await history()).toHaveLength(2);
}
it('accepts a verified email after trimming and ignoring case', matchingEmail);

async function inviterEnded(type: string, emailOnly = false) {
  await invite(emailOnly ? { invitedIdentity: undefined } : {});
  let data: Record<string, unknown>;
  if (type === 'member.removed') {
    data = { memberId: 'admin', removedBy: 'owner' };
  } else {
    data = { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
  }
  const changed = { ...event(randomUUID(), 'member-admin', type), silo: 'acme', data };
  const position = await nats.store.head('member-admin');
  const command = { event: changed, expectedSequence: position };
  expect((await nats.store.append(command)).status).toBe('appended');
  expect((await accept()).json()).toEqual({
    status: 'refused', reason: 'inviter_authority_ended',
  });
  expect(await history()).toHaveLength(1);
}
const inviterChanges = ['member.role_changed', 'member.removed'];
async function boundInviterEnded(type: string) {
  await inviterEnded(type);
}
it.each(inviterChanges)('refuses an inviter after %s', boundInviterEnded);

async function invalidAdmission(kind: string) {
  let earlier: StoredEvent['event'] = invitation();
  if (kind === 'removed') {
    earlier = { ...earlier, type: 'member.removed',
      data: { memberId: 'alice', removedBy: 'admin' } };
  } else if (kind === 'active') {
    earlier = { ...earlier, type: 'member.joined', data: {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
    } };
  } else if (kind === 'rebound') {
    earlier = invitation({ invitedIdentity: { issuer: config.issuerUrl, sub: 'other' } });
  }
  expect((await nats.store.append({ event: earlier, expectedSequence: 0 })).status)
    .toBe('appended');
  const previous = await nats.store.head('member-alice');
  const patch = kind === 'owner' ? { role: 'owner' } : {};
  const next = invitation(patch);
  expect((await nats.store.append({ event: next, expectedSequence: previous })).status)
    .toBe('appended');
  const response = await accept();
  let reason = 'invitation_not_pending';
  if (kind === 'removed') reason = 'access_removed';
  if (kind === 'rebound') reason = 'wrong_identity';
  if (kind === 'owner') reason = 'ownership_stream_required';
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await history()).toHaveLength(2);
}
const admissionRefusals = ['removed', 'rebound', 'active', 'owner'];
it.each(admissionRefusals)('refuses a %s admission', invalidAdmission);


async function seedInviter() {
  const data = {
    memberId: 'admin', displayName: 'Admin', email: 'admin@example.test', role: 'admin',
  };
  const joined = { ...event(randomUUID(), 'member-admin', 'member.joined'), silo: 'acme', data };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status)
    .toBe('appended');
}


async function lostReply(emailOnly = false) {
  await invite(emailOnly ? { invitedIdentity: undefined } : {});
  const append = nats.store.append.bind(nats.store);
  async function appendWithoutReply(command: Parameters<JoinStore['append']>[0]): Promise<never> {
    const result = await append(command);
    expect(result.status).toBe('appended');
    throw new Error('Reply lost');
  }
  const interception = vi.spyOn(nats.store, 'append').mockImplementationOnce(appendWithoutReply);
  const response = await accept();
  expect(response.statusCode).toBe(503);
  interception.mockRestore();
  await nats.stop();
  await nats.restart();
  expect((await accept()).json()).toEqual({
    status: 'already_joined', memberId: 'alice', sequence: 3,
  });
  expect(await history()).toHaveLength(2);
}
it.each([false, true])('recovers a lost append reply after reconnecting (email-only %s)',
  lostReply);

async function refusesBodyIdentity() {
  await invite();
  const mismatched = { ...input, memberId: 'other' };
  expect((await accept(mismatched)).json()).toEqual({
    status: 'refused', reason: 'unknown_invitation',
  });
  const forged = { ...input, email: session.email, emailVerified: true };
  expect((await accept(forged)).json()).toEqual({
    status: 'refused', reason: 'invalid_request',
  });
  const oversized = { ...input, displayName: 'x'.repeat(1100) };
  const response = await accept(oversized);
  expect(response.statusCode).toBe(413);
  expect(await history()).toHaveLength(1);
}
it('rejects a different member id, body email claims and a body larger than 1 KiB',
  refusesBodyIdentity);

async function refusesChangedAuthority() {
  await invite();
  const read = nats.store.readStream.bind(nats.store);
  let changed = false;
  async function* changeDuringRead(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    if (subject !== 'member-admin' || changed) return;
    changed = true;
    const position = await nats.store.head(subject);
    const data = { memberId: 'admin', removedBy: 'owner' };
    const removal = { ...event(randomUUID(), subject, 'member.removed'), silo: 'acme', data };
    const command = { event: removal, expectedSequence: position };
    expect((await nats.store.append(command)).status).toBe('appended');
  }
  const interception = vi.spyOn(nats.store, 'readStream').mockImplementation(changeDuringRead);
  try {
    const response = await accept();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused', reason: 'inviter_authority_ended' });
    expect(await history()).toHaveLength(1);
  } finally {
    interception.mockRestore();
  }
}
it('refuses authority lost during the final event check without saving a join',
  refusesChangedAuthority);

async function expiryAfterAuthority(emailOnly = false) {
  await invite({ expiresAt: '2026-10-01T12:00:01Z',
    ...(emailOnly ? { invitedIdentity: undefined } : {}) });
  const head = nats.store.head.bind(nats.store);
  async function advanceClock(subject?: string, deadline?: number) {
    const position = await head(subject, deadline);
    if (subject === 'member-admin') clock = new Date('2026-10-01T12:00:01Z');
    return position;
  }
  const interception = vi.spyOn(nats.store, 'head').mockImplementation(advanceClock);
  try {
    const response = await accept();
    expect(response.json()).toEqual({ status: 'refused', reason: 'expired_invitation' });
    expect(await history()).toHaveLength(1);
  } finally {
    interception.mockRestore();
  }
}
it.each([false, true])('rechecks expiry after the final authority check (email-only %s)',
  expiryAfterAuthority);

const identityOrderingCases = [
  { state: 'expired', claim: 'account' },
  { state: 'expired', claim: 'email' },
  { state: 'accepted', claim: 'account' },
  { state: 'accepted', claim: 'email' },
];
async function identityBeforeState({ state, claim }: { state: string; claim: string }) {
  const patch = state === 'expired' ? { expiresAt: clock.toISOString() } : {};
  await invite(patch);
  if (state === 'accepted') expect((await accept()).statusCode).toBe(200);
  const identity = { ...session };
  if (claim === 'account') identity.sub = 'another-account';
  else identity.email = 'another@example.test';
  const command = { ...input, commandId: 'another-command' };
  const before = await nats.store.head();
  const response = await accept(command, identity);
  expect(response.json()).toEqual({ status: 'refused', reason: 'wrong_identity' });
  expect(await nats.store.head()).toBe(before);
}
it.each(identityOrderingCases)(
  'checks the $claim before revealing an $state invitation', identityBeforeState);

async function noStoreReplies() {
  await invite();
  const joined = await accept();
  const retry = await accept();
  const refused = await accept(input, { ...session, sub: 'another-account' });
  const missing = await app.inject({ method: 'POST', url: '/members/join', payload: input });
  for (const response of [joined, retry, refused, missing]) {
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(await history()).toHaveLength(2);
}
it('marks acceptance, retry and refusal replies as no-store', noStoreReplies);

async function inviterRefusalStatus(emailOnly = false) {
  await invite({ invitedBy: 'absent-inviter',
    ...(emailOnly ? { invitedIdentity: undefined } : {}) });
  const response = await accept();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused', reason: 'inviter_authority_ended' });
  expect(await history()).toHaveLength(1);
}
it.each([false, true])('returns 403 when inviter authority ended (email-only %s)',
  inviterRefusalStatus);

async function missingEmailClaim() {
  await invite();
  const { email: _omitted, ...identity } = session;
  const response = await accept(input, identity);
  expect(response.json()).toEqual({ status: 'refused', reason: 'sign_in_again' });
  expect(await history()).toHaveLength(1);
}
it('requires sign-in again when verified is true but the email claim is missing',
  missingEmailClaim);

async function ownerInviter(emailOnly = false) {
  const roleChange = { ...event(randomUUID(), 'member-admin', 'member.role_changed'),
    silo: 'acme', data: { memberId: 'admin', previousRole: 'admin', newRole: 'member',
      changedBy: 'owner' } };
  expect((await nats.store.append({ event: roleChange, expectedSequence: 1 })).status)
    .toBe('appended');
  const ownership = { ...event(randomUUID(), 'ownership-acme', 'ownership.seeded'),
    silo: 'acme', data: { ownerIds: ['admin'] } };
  expect((await nats.store.append({ event: ownership, expectedSequence: 0 })).status)
    .toBe('appended');
  await invite(emailOnly ? { invitedIdentity: undefined } : {});
  const response = await accept();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'joined' });
  expect(await history()).toHaveLength(2);
}
it.each([false, true])('accepts an invitation from a recorded Owner (email-only %s)',
  ownerInviter);

async function recentSignIn(age: number) {
  await invite();
  const identity = { ...session, authTime: clock.getTime() / 1000 - age };
  const response = await accept(input, identity);
  if (age >= 0 && age <= 3600) {
    expect(response.json()).toMatchObject({ status: 'joined' });
    expect(await history()).toHaveLength(2);
  } else {
    expect(response.json()).toEqual({ status: 'refused', reason: 'sign_in_again' });
    expect(await history()).toHaveLength(1);
  }
}
it.each([3599, 3600, 3601, -1, 1790856000])('requires a sign-in within 60 minutes (age %s)', recentSignIn);

async function nonAsciiEmail(email: string) {
  await invite({ email: 'kelvin@example.test' });
  const identity = { ...session, email };
  const response = await accept(input, identity);
  expect(response.json()).toEqual({ status: 'refused', reason: 'unsupported_email' });
  expect(await history()).toHaveLength(1);
}
it.each(['Kelvin@example.test', 'kelvin@éxample.test'])(
  'refuses the non-ASCII session email %s', nonAsciiEmail);

async function acceptsEmailInvitation() {
  await invite({ invitedIdentity: undefined, personalAssistant: 'none' });
  const identity = { ...session, email: ' ALICE@Example.test ' };
  const response = await accept(input, identity);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'joined', memberId: 'alice', sequence: 3 });
  const records = await history();
  expect(records).toHaveLength(2);
  expect(records[1]?.event.data).toMatchObject({
    memberId: 'alice', personalAssistant: 'none',
    identity: { issuer: config.issuerUrl, sub: session.sub },
  });
}
it('binds an email-only invitation to the verified account using its member id',
  acceptsEmailInvitation);

async function retriesEmailInvitation() {
  await invite({ invitedIdentity: undefined });
  expect((await accept()).statusCode).toBe(200);
  const saved = await history();
  clock = new Date('2026-10-03T12:00:00Z');
  const identity = { ...session, emailVerified: false };
  const response = await accept(input, identity);
  expect(response.json()).toEqual({
    status: 'already_joined', memberId: 'alice', sequence: 3,
  });
  expect(await history()).toEqual(saved);
}
it('returns the saved email-only join after expiry without checking email again',
  retriesEmailInvitation);

async function refusesActiveIdentity(kind: string) {
  let identity = { issuer: config.issuerUrl, sub: session.sub };
  if (kind === 'other-issuer') identity = { ...identity, issuer: 'https://other.test' };
  if (kind === 'other-subject') identity = { ...identity, sub: 'another' };
  const data = { memberId: 'existing', displayName: 'Alice', email: session.email,
    role: 'member', identity };
  let record: StoredEvent['event'] = {
    ...event(randomUUID(), 'member-existing', 'member.joined'),
    silo: 'acme', data };
  if (kind === 'bootstrap') {
    record = { ...record, type: 'silo.owner_bootstrapped', subject: 'member-bootstrap-owner',
      data: { ...data, memberId: 'bootstrap-owner', role: 'owner' } };
  }
  if (kind === 'bound') {
    const earlier = { ...invitation(), subject: 'member-existing', data: {
      memberId: 'existing', email: session.email, role: 'member', invitedBy: 'admin',
      invitationId: 'earlier', invitedIdentity: identity,
    } };
    expect((await nats.store.append({ event: earlier, expectedSequence: 0 })).status)
      .toBe('appended');
    const { identity: _omitted, ...legacy } = data;
    record = { ...record, data: legacy };
  }
  const position = await nats.store.head(record.subject);
  expect((await nats.store.append({ event: record, expectedSequence: position })).status)
    .toBe('appended');
  if (kind === 'departed') {
    const removal = { ...event(randomUUID(), record.subject, 'member.removed'),
      silo: 'acme', data: { memberId: 'existing', removedBy: 'admin' } };
    const expectedSequence = await nats.store.head(record.subject);
    await nats.store.append({ event: removal, expectedSequence });
  }
  await invite({ invitedIdentity: undefined });
  const before = await nats.store.head();
  const response = await accept();
  if (['other-issuer', 'other-subject', 'departed'].includes(kind)) {
    expect(response.statusCode).toBe(200);
    expect(await nats.store.head()).toBe(before + 1);
    return;
  }
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', reason: 'already_member' });
  expect(await nats.store.head()).toBe(before);
}
it.each(['joined', 'bound', 'bootstrap', 'other-issuer', 'other-subject', 'departed'])(
  'checks current issuer and subject across the silo (%s) while the read table is delayed',
  refusesActiveIdentity);

const emailInvitationRefusals = [
  { name: 'unverified email', identity: { ...session, emailVerified: false },
    reason: 'wrong_identity' },
  { name: 'missing verification', identity: { ...session, emailVerified: undefined },
    reason: 'sign_in_again' },
  { name: 'missing email', identity: { ...session, email: undefined }, reason: 'sign_in_again' },
  { name: 'different email', identity: { ...session, email: 'other@example.test' },
    reason: 'wrong_identity' },
  { name: 'non-ASCII email', identity: { ...session, email: 'Kelvin@example.test' },
    reason: 'unsupported_email' },
  { name: 'old sign-in', identity: { ...session, authTime: 1790852399 },
    reason: 'sign_in_again' },
  { name: 'future sign-in', identity: { ...session, authTime: 1790856001 },
    reason: 'sign_in_again' },
  { name: 'missing sign-in time', identity: { ...session, authTime: 0 },
    reason: 'sign_in_again' },
  { name: 'other organisation', identity: { ...session, orgId: 'org-other' },
    reason: 'wrong_silo' },
  { name: 'allowlisted external account',
    identity: { ...session, sub: 'idp-owner', orgId: 'org-other' }, reason: 'wrong_silo' },
];
async function refusesEmailInvitation({ identity, reason }:
  { identity: SessionData; reason: string }) {
  await invite({ invitedIdentity: undefined });
  const response = await accept(input, identity);
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await history()).toHaveLength(1);
}
it.each(emailInvitationRefusals)('refuses an email-only invitation for $name',
  refusesEmailInvitation);

async function acceptsSignInBoundary() {
  await invite({ invitedIdentity: undefined });
  const identity = { ...session, authTime: 1790852400 };
  expect((await accept(input, identity)).statusCode).toBe(200);
}
it('accepts an email-only invitation at exactly 60 minutes since sign-in',
  acceptsSignInBoundary);

async function emailInvitationState(kind: string) {
  let patch: Record<string, unknown> = { invitedIdentity: undefined };
  if (kind === 'expired') patch = { ...patch, expiresAt: clock.toISOString() };
  await invite(patch);
  let reason = 'expired_invitation';
  if (kind === 'accepted') {
    expect((await accept()).statusCode).toBe(200);
    reason = 'invitation_not_pending';
  }
  if (kind === 'removed') {
    const data = { memberId: 'alice', removedBy: 'admin' };
    const removal = { ...event(randomUUID(), 'member-alice', 'member.removed'),
      silo: 'acme', data };
    expect((await nats.store.append({ event: removal, expectedSequence: 2 })).status)
      .toBe('appended');
    reason = 'access_removed';
  }
  const before = await history();
  const body = { ...input, commandId: 'second-join' };
  const response = await accept(body);
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await history()).toEqual(before);
}
it.each(['expired', 'accepted', 'removed'])(
  'refuses an email-only invitation that is %s', emailInvitationState);

async function racesEmailAccounts(sameCommand: boolean) {
  await invite({ invitedIdentity: undefined });
  const append = nats.store.append.bind(nats.store);
  let writes = 0;
  let release: () => void = pendingRelease;
  function pendingRelease() {}
  function setRelease(resolve: () => void) {
    release = resolve;
  }
  const barrier = new Promise<void>(setRelease);
  async function competingAppend(command: Parameters<typeof append>[0]) {
    writes++;
    if (writes === 2) release();
    await barrier;
    return append(command);
  }
  const interception = vi.spyOn(nats.store, 'append').mockImplementation(competingAppend);
  const body = { ...input, commandId: sameCommand ? input.commandId : 'other-command' };
  const other = { ...session, sub: 'other-account' };
  try {
    const responses = await Promise.all([accept(), accept(body, other)]);
    function responseStatus(response: typeof responses[number]) {
      return response.statusCode;
    }
    const statuses = responses.map(responseStatus);
    statuses.sort();
    expect(statuses).toEqual([200, 409]);
    for (const response of responses) {
      if (response.statusCode === 409) {
        expect(response.json()).toEqual({ status: 'refused', reason: 'wrong_identity' });
      }
    }
    const records = await history();
    expect(records).toHaveLength(2);
    const joined = records[1]!;
    expect(joined.event.data).toMatchObject({
      identity: { issuer: config.issuerUrl, sub: joined.event.principal?.id },
    });
  } finally {
    interception.mockRestore();
  }
}
it.each([false, true])('lets one email account append and refuses the other (same command %s)',
  racesEmailAccounts);


async function refusesAccountJoinedDuringAccessCheck() {
  await invite({ invitedIdentity: undefined });
  const head = nats.store.head.bind(nats.store);
  let changed = false;
  async function competingJoin(subject?: string, deadline?: number) {
    const position = await head(subject, deadline);
    if (subject === 'member-alice' && !changed) {
      changed = true;
      const data = { memberId: 'alice', invitationId: input.invitationId,
        email: session.email, displayName: 'Other', role: 'member',
        identity: { issuer: config.issuerUrl, sub: 'other-account' } };
      const joined = { ...event(randomUUID(), subject, 'member.joined'), silo: 'acme',
        principal: { kind: 'human', id: 'other-account' }, data };
      expect((await nats.store.append({ event: joined, expectedSequence: position })).status)
        .toBe('appended');
      return head(subject, deadline);
    }
    return position;
  }
  const interception = vi.spyOn(nats.store, 'head').mockImplementation(competingJoin);
  try {
    const response = await accept();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', reason: 'wrong_identity' });
    expect(await history()).toHaveLength(2);
  } finally {
    interception.mockRestore();
  }
}
it('clearly refuses another account that joins during the final access check',
  refusesAccountJoinedDuringAccessCheck);

async function emailInviterEnded(type: string) {
  await inviterEnded(type, true);
}
it.each(inviterChanges)('refuses an email-only invitation after inviter %s', emailInviterEnded);
