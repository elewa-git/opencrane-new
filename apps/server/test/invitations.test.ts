import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { memberInvitedDataSchema, parseEventByType } from '@opencrane/events';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import type { Query } from '@opencrane/projections';
import { members, pgDb, ProjectionRunner, auditTrail, rebuildAuditProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { refusalDigest } from '../src/members/refusals.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme',
  extraIdentities: [{ issuer: 'https://idp.example.test', subject: 'admin' }] });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let app: ReturnType<typeof buildServer>;
const email = 'person@example.test';
const memberId = randomUUID();
let clock = new Date('2026-10-01T12:00:00Z');
function now() {
  return clock;
}
const input = { commandId: 'invite-person', memberId, email,
  expectedSequence: 0, role: 'member', personalAssistant: 'none' };

async function services() {
  fga = await openfga();
  dbs = await databases();
}
beforeAll(services, 120_000);
async function closeServices() {
  await dbs?.close();
  await fga?.close();
}
afterAll(closeServices);
function resolveMember(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function server(db: Query = pgDb(dbs.queue)) {
  const options = { silo: 'acme', store: nats.store, binding, db, now,
    feed: { memberId: resolveMember } };
  const membership = { silo: 'acme', store: nats.store, db: pgDb(dbs.queue), now };
  return buildServer(config, { invitationEmail: options, membership, audit: options });
}
async function append(subject: string, type: string, data: unknown, apply = false) {
  const record = { ...event(randomUUID(), subject, type), silo: 'acme', data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  await members.apply(pgDb(dbs.queue), record, await nats.store.head(subject));
  if (apply) await memberAuthorisation(binding).handler.handle(record, pgDb(dbs.queue));
}
async function fixture() {
  clock = new Date('2026-10-01T12:00:00Z');
  await members.drop(pgDb(dbs.queue));
  await members.create(pgDb(dbs.queue));
  nats = await natsFixture();
  binding = await createStore(fga.apiUrl, 'acme');
  for (const role of ['owner', 'admin', 'member']) {
    const data = { memberId: role, displayName: role, email: `${role}@example.test`, role };
    await append(`member-${role}`, 'member.joined', data, true);
  }
  await prepareAcceptanceProjection();
  app = server();
}
beforeEach(fixture);
async function closeFixture() {
  vi.restoreAllMocks();
  await app?.close();
  await nats?.close();
}
afterEach(closeFixture);
function request(method: 'GET' | 'POST', payload: unknown = input,
  sub = 'admin', orgId = 'org-acme', origin = 'https://app.example.test') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { origin, 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  let url = '/api/invitations';
  if (method === 'GET') url += `/${memberId}/changes/${input.commandId}`;
  const options = { method, url, headers };
  if (method === 'GET') return app.inject(options);
  return app.inject({ ...options, payload: JSON.stringify(payload) });
}
function records() {
  return history(nats.store, `member-${memberId}`, 'acme');
}

async function createsOnce(role: string) {
  const appendSpy = vi.spyOn(nats.store, 'append');
  const body = { ...input, email: '  PERSON@EXAMPLE.TEST  ' };
  const response = await request('POST', body, role);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const saved = await records();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.event).toMatchObject({ type: 'member.invited', commandId: input.commandId,
    principal: { kind: 'human', id: role }, data: { memberId, email, role: 'member',
      invitedBy: role, personalAssistant: 'none' } });
  const data = memberInvitedDataSchema.parse(saved[0]?.event.data);
  expect(data).not.toHaveProperty('invitedIdentity');
  const createdAt = Date.parse(saved[0]!.event.time);
  expect(saved[0]!.event.time).toBe(clock.toISOString());
  expect(Date.parse(data.expiresAt!) - createdAt).toBe(7 * 86_400_000);
  expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({ historyChecked: true,
    expectedSequence: 0 });
  expect((await request('POST', body, role)).json()).toEqual(response.json());
  expect(appendSpy).toHaveBeenCalledTimes(1);
  expect(await records()).toEqual(saved);
  appendSpy.mockRestore();
}
it.each(['owner', 'admin'])('allows a current %s to invite once and repeat', createsOnce);

const invalidBodies = [
  { ...input, role: 'owner' }, { ...input, personalAssistant: undefined },
  { ...input, personalAssistant: 'maybe' }, { ...input, invitedBy: 'owner' },
  { ...input, email: 'K@example.test' }, { ...input, commandId: 'x'.repeat(201) },
  { ...input, email: ' '.repeat(1024) + email },
];
async function refusesInvalidBody(body: unknown) {
  expect((await request('POST', body)).statusCode).toBe(400);
  expect(await records()).toEqual([]);
}
it.each(invalidBodies)('refuses invalid or oversized invitation input %#', refusesInvalidBody);

async function refusesAccess(sub: string, org: string, origin: string) {
  expect((await request('POST', input, sub, org, origin)).statusCode).toBe(403);
  expect(await records()).toEqual([]);
}
it.each([
  ['member', 'org-acme', 'https://app.example.test'],
  ['unknown', 'org-acme', 'https://app.example.test'],
  ['admin', 'other-org', 'https://app.example.test'],
  ['admin', 'org-acme', 'https://evil.example.test'],
  ['admin', 'org-acme', 'https://app.example.test/'],
])('refuses stale role, identity, organisation or Origin (%s, %s, %s)', refusesAccess);

async function refusesMissingSession() {
  const options = { method: 'POST' as const, url: '/api/invitations', payload: input };
  expect((await app.inject(options)).statusCode).toBe(401);
  expect(await records()).toEqual([]);
}
it('requires an encrypted session', refusesMissingSession);
async function refusesBodyId() {
  const body = { ...input, memberId: 'someone-else' };
  expect((await request('POST', body)).json()).toMatchObject({ reason: 'identity_mismatch' });
  expect(await history(nats.store, 'member-someone-else', 'acme')).toEqual([]);
}
it('requires a random UUID for a new invitation', refusesBodyId);
async function refusesActiveTarget() {
  const data = { memberId: 'existing', displayName: 'Person', email, role: 'member' };
  await append('member-existing', 'member.joined', data);
  expect((await request('POST')).json()).toMatchObject({ reason: 'already_member' });
  expect(await records()).toEqual([]);
}
it('refuses an active projected target after checking its events', refusesActiveTarget);
async function refusesRemovedStream() {
  await append(`member-${memberId}`, 'member.removed', { memberId, removedBy: 'admin' });
  const before = await records();
  const body = { ...input, expectedSequence: before[0]!.sequence };
  expect((await request('POST', body)).json()).toMatchObject({ reason: 'access_removed' });
  expect(await records()).toEqual(before);
}
it('never reopens a removed invitation stream', refusesRemovedStream);

async function renews(expired: boolean) {
  await request('POST');
  if (expired) {
    const saved = (await records())[0]!;
    const data = memberInvitedDataSchema.parse(saved.event.data);
    clock = new Date(data.expiresAt!);
  }
  const before = await records();
  const body = { ...input, commandId: 'renew-person', role: 'admin',
    personalAssistant: 'provision', expectedSequence: before.at(-1)!.sequence };
  expect((await request('POST', body)).statusCode).toBe(200);
  const after = await records();
  expect(after).toHaveLength(before.length + 1);
  expect(after.slice(0, -1)).toEqual(before);
  expect(after.at(-1)?.event.data).toMatchObject({ email, role: 'admin',
    personalAssistant: 'provision' });
  const prior = memberInvitedDataSchema.parse(before.at(-1)?.event.data);
  expect(after.at(-1)?.event.data).not.toMatchObject({ invitationId: prior.invitationId });
}
it.each([false, true])('renews a pending or expired invitation (%s)', renews);
async function refusesChangedReplay(field: string, value: unknown) {
  const first = await request('POST');
  expect(first.statusCode).toBe(200);
  const before = await records();
  const body = { ...input, [field]: value };
  expect((await request('POST', body)).json()).toMatchObject({ reason: 'command_id_reused' });
  expect(await records()).toEqual(before);
}
it.each([['role', 'admin'], ['personalAssistant', 'provision'], ['expectedSequence', 1],
  ['email', 'changed@example.test']])(
  'refuses changed %s under the original command id', refusesChangedReplay);

async function reconcilesLostReply() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof append>[0]) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(loseReply);
  expect((await request('GET')).statusCode).toBe(404);
  expect((await request('POST')).statusCode).toBe(503);
  spy.mockRestore();
  await app.close();
  await nats.stop();
  await nats.restart();
  app = server();
  const before = await records();
  const writes = vi.spyOn(nats.store, 'append');
  const status = await request('GET');
  expect(status.statusCode).toBe(200);
  expect(status.headers['cache-control']).toBe('no-store');
  const change = await changeRead();
  expect(change.json()).toMatchObject({ status: 'recorded', sequence: before[0]!.sequence,
    recordedAt: before[0]!.event.time, result: status.json<Record<string, unknown>>() });
  expect((await request('POST')).json()).toEqual(status.json());
  expect(writes).not.toHaveBeenCalled();
  expect(await records()).toEqual(before);
  expect((await request('GET', undefined, 'member')).statusCode).toBe(403);
  writes.mockRestore();
}
it('reads the saved command after a lost reply and restart without writing', reconcilesLostReply);

async function demotesDuringRequest(duringHistory: boolean) {
  let changed = false;
  async function demote() {
    if (changed) return;
    changed = true;
    const data = { memberId: 'admin', previousRole: 'admin', newRole: 'member',
      changedBy: 'owner' };
    await append('member-admin', 'member.role_changed', data, true);
  }
  if (duringHistory) {
    const read = nats.store.readStream.bind(nats.store);
    async function* slowHistory(...args: Parameters<typeof read>) {
      yield* read(...args);
      if (args[0] === `member-${memberId}`) await demote();
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(slowHistory);
  } else {
    const head = nats.store.head.bind(nats.store);
    async function earlierAuthority(...args: Parameters<typeof head>) {
      const position = await head(...args);
      if (args[0] === 'member-admin') await demote();
      return position;
    }
    vi.spyOn(nats.store, 'head').mockImplementation(earlierAuthority);
  }
  const response = await request('POST');
  expect(response.statusCode).toBe(403);
  expect(await records()).toEqual([]);
  vi.restoreAllMocks();
}
it.each([true, false])('refuses demotion during history or the write access check (%s)',
  demotesDuringRequest);

async function refusesStaleReview() {
  expect((await request('POST')).statusCode).toBe(200);
  const before = await records();
  const body = { ...input, commandId: 'stale-review' };
  expect((await request('POST', body)).json()).toMatchObject({ reason: 'concurrent_change' });
  expect(await records()).toEqual(before);
}
it('refuses renewal at a position older than the reviewed invitation', refusesStaleReview);
async function keepsEmailAndIdentity(bound: boolean) {
  const data = { memberId, email: 'different@example.test', role: 'member',
    invitationId: 'earlier', invitedBy: 'admin' };
  let earlier: unknown = data;
  if (bound) {
    earlier = { ...data, email,
      invitedIdentity: { issuer: config.issuerUrl, sub: 'another-account' } };
  }
  await append(`member-${memberId}`, 'member.invited', earlier);
  const before = await records();
  const body = { ...input, expectedSequence: before[0]!.sequence };
  expect((await request('POST', body)).json()).toMatchObject({ reason: 'identity_mismatch' });
  expect(await records()).toEqual(before);
}
it.each([false, true])('refuses renewal of another email or a bound account (%s)',
  keepsEmailAndIdentity);
async function survivesSlowHistory() {
  const read = nats.store.readStream.bind(nats.store);
  let delayed = false;
  async function* slowHistory(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] !== `member-${memberId}` || delayed) return;
    delayed = true;
    function finish(resolve: () => void) { setTimeout(resolve, 2100); }
    await new Promise<void>(finish);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(slowHistory);
  expect((await request('POST')).statusCode).toBe(200);
  expect(await records()).toHaveLength(1);
}
it('finishes slow target history before the two-second write check', survivesSlowHistory);
async function racesSameCommand() {
  const responses = await Promise.all([request('POST'), request('POST')]);
  expect(await records()).toHaveLength(1);
  const first = responses[0];
  const second = responses[1];
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(first.json()).toEqual(second.json());
  expect((await request('POST')).statusCode).toBe(200);
}
it('stores one invitation when identical original commands race', racesSameCommand);
async function refusesWrongSilo() {
  binding.silo = 'other';
  expect((await request('POST')).statusCode).toBe(403);
  expect(await records()).toEqual([]);
}
it('refuses services configured for another silo', refusesWrongSilo);
async function refusesUnavailableIam() {
  binding.apiUrl = 'http://127.0.0.1:1';
  expect((await request('POST')).statusCode).toBe(503);
  expect(await records()).toEqual([]);
}
it('saves no invitation when IAM is unavailable', refusesUnavailableIam);

async function refusesTargetJoining() {
  const data = { memberId, email, role: 'member', invitedBy: 'admin',
    invitationId: 'pending' };
  await append(`member-${memberId}`, 'member.invited', data);
  const read = nats.store.readStream.bind(nats.store);
  let actorReads = 0;
  async function* joinDuringAuthority(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] !== 'member-admin' || ++actorReads !== 2) return;
    const joined = { memberId, email, role: 'member', displayName: 'Person' };
    await append(`member-${memberId}`, 'member.joined', joined);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(joinDuringAuthority);
  const before = await records();
  const body = { ...input, expectedSequence: before[0]!.sequence };
  const response = await request('POST', body);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'concurrent_change' });
  const after = await records();
  expect(after).toHaveLength(2);
  expect(after.at(-1)?.event.type).toBe('member.joined');
}
it('refuses a matching pending target that joins during the write check', refusesTargetJoining);

async function acceptsEmailInvitation() {
  const created = await request('POST');
  expect(created.statusCode).toBe(200);
  const invitation = created.json<{ invitationId: string }>();
  const before = await records();
  const session = { sub: 'person', orgId: 'org-acme', roles: [],
    email, emailVerified: true, authTime: clock.getTime() / 1000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const payload = { memberId, invitationId: invitation.invitationId,
    commandId: 'accept-person', displayName: 'Person' };
  const options = { method: 'POST' as const, url: '/members/join', headers, payload };
  const response = await app.inject(options);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'joined', memberId });
  const after = await records();
  expect(after.slice(0, -1)).toEqual(before);
  expect(after.at(-1)?.event.data).toMatchObject({
    identity: { issuer: config.issuerUrl, sub: 'person' }, personalAssistant: 'none',
  });
  const db = pgDb(dbs.queue);
  await members.apply(db, after.at(-1)!.event, after.at(-1)!.sequence);
  const query = 'SELECT issuer, sub FROM member_identities WHERE silo = $1 AND member_id = $2';
  const expected = [{ issuer: config.issuerUrl, sub: 'person' }];
  expect((await db.query(query, ['acme', memberId])).rows).toEqual(expected);
  expect((await request('POST')).json()).toEqual(created.json());
  expect(await records()).toEqual(after);
  await members.drop(db);
  await members.create(db);
  for (const row of after) await members.apply(db, row.event, row.sequence);
  expect((await db.query(query, ['acme', memberId])).rows).toEqual(expected);
}
it('accepts a route-created email invitation and rebuilds its account binding',
  acceptsEmailInvitation);

async function reinvitesRemovedEmail() {
  const joined = { memberId: 'old-person', displayName: 'Person', email, role: 'member' };
  await append('member-old-person', 'member.joined', joined);
  await append('member-old-person', 'member.removed',
    { memberId: 'old-person', removedBy: 'admin' });
  const old = await history(nats.store, 'member-old-person', 'acme');
  expect((await request('POST')).statusCode).toBe(200);
  expect(await records()).toHaveLength(1);
  expect(await history(nats.store, 'member-old-person', 'acme')).toEqual(old);
}
it('uses a new opaque id when inviting a removed member email again', reinvitesRemovedEmail);

async function refusesOtherAdminReplay() {
  expect((await request('POST')).statusCode).toBe(200);
  const before = await records();
  const response = await request('POST', input, 'owner');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'command_id_reused' });
  expect(await records()).toEqual(before);
}
it('refuses another admin reusing the same command id', refusesOtherAdminReplay);

async function racesDifferentCommands() {
  const other = { ...input, commandId: 'other-admin-invite' };
  const responses = await Promise.all([request('POST'), request('POST', other, 'owner')]);
  const statuses: number[] = [];
  for (const response of responses) statuses.push(response.statusCode);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  for (const response of responses) {
    if (response.statusCode === 409) {
      expect(response.json()).toMatchObject({ status: 'refused', reason: 'concurrent_change' });
    }
  }
  expect(await records()).toHaveLength(1);
}
it('stores one event when two admins invite the same target with different commands',
  racesDifferentCommands);

async function refusesStatusAccess(kind: string) {
  expect((await request('POST')).statusCode).toBe(200);
  const before = await records();
  let response;
  if (kind === 'session') {
    const url = `/api/invitations/${memberId}/changes/${input.commandId}`;
    const options = { method: 'GET' as const, url };
    response = await app.inject(options);
  } else if (kind === 'organisation') {
    response = await request('GET', undefined, 'admin', 'other-org');
  } else {
    binding.silo = 'other';
    response = await request('GET');
  }
  const expectedStatus = kind === 'session' ? 401 : 403;
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await records()).toEqual(before);
}
it.each(['session', 'organisation', 'silo'])('refuses status reads with wrong %s',
  refusesStatusAccess);

async function refusesBadHistory(kind: string) {
  const read = nats.store.readStream.bind(nats.store);
  const record = { ...event('broken-invitation', `member-${memberId}`, 'member.invited'),
    silo: 'acme', data: { memberId, email, role: 'member', invitedBy: 'admin',
      invitationId: 'broken' } };
  async function* brokenHistory(...args: Parameters<typeof read>) {
    if (args[0] !== `member-${memberId}`) {
      yield* read(...args);
      return;
    }
    if (kind === 'cap') {
      for (let index = 1; index <= 10_001; index += 1) {
        yield { sequence: index, event: record };
      }
    } else if (kind === 'silo') {
      yield { sequence: 1, event: { ...record, silo: 'other' } };
    } else {
      yield { sequence: 1, event: { ...record, data: { memberId } } };
    }
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(brokenHistory);
  const writes = vi.spyOn(nats.store, 'append');
  expect((await request('POST')).statusCode).toBe(503);
  expect((await request('GET')).statusCode).toBe(503);
  expect(writes).not.toHaveBeenCalled();
  spy.mockRestore();
  expect(await records()).toEqual([]);
}
it.each(['cap', 'silo', 'schema'])('returns unavailable for stored history failure: %s',
  refusesBadHistory);

async function checksSequenceBeforeAppend() {
  const writes = vi.spyOn(nats.store, 'append');
  const body = { ...input, expectedSequence: 1 };
  const response = await request('POST', body);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'concurrent_change' });
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes.mock.calls[0]?.[0].event).toMatchObject({ type: 'member.command_refused' });
  expect(await records()).toEqual([]);
}
it('compares the reviewed position before passing historyChecked to append',
  checksSequenceBeforeAppend);

async function checksCandidateEvents() {
  const data = { memberId: 'existing', displayName: 'Person', email, role: 'member' };
  await append('member-existing', 'member.joined', data);
  await dbs.queue.query("UPDATE members SET status = 'invited' WHERE member_id = 'existing'");
  const read = nats.store.readStream.bind(nats.store);
  async function* exactStreams(...args: Parameters<typeof read>) {
    expect(args[0]).not.toBe('member-*');
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(exactStreams);
  const response = await request('POST');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'already_member' });
  expect(await records()).toEqual([]);
}
it('uses the email projection to find candidates and their events to decide membership',
  checksCandidateEvents);

async function refusesExcessCandidates() {
  for (let index = 0; index < 101; index += 1) {
    await dbs.queue.query('INSERT INTO members VALUES ($1, $2, $3, NULL, $4, $5)',
      ['acme', `candidate-${index}`, email, 'member', 'invited']);
  }
  expect((await request('POST')).statusCode).toBe(503);
  expect(await records()).toEqual([]);
}
it('returns unavailable when the email query exceeds its candidate limit',
  refusesExcessCandidates);

async function findsExistingInvitation() {
  expect((await request('POST')).statusCode).toBe(200);
  const saved = (await records())[0]!;
  await members.apply(pgDb(dbs.queue), saved.event, saved.sequence);
  const otherId = randomUUID();
  const body = { ...input, memberId: otherId, commandId: 'invite-again' };
  const response = await request('POST', body);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'identity_mismatch' });
  expect(await history(nats.store, `member-${otherId}`, 'acme')).toEqual([]);
  const renewal = { ...input, commandId: 'renew-existing', expectedSequence: saved.sequence };
  expect((await request('POST', renewal)).statusCode).toBe(200);
  expect(await records()).toHaveLength(2);
}
it('finds the existing invitation by email and requires its id for renewal',
  findsExistingInvitation);


async function reconcilesSavedDuringFence() {
  const originalRead = nats.store.readStream.bind(nats.store);
  let actorReads = 0;
  let saved = false;
  async function* saveDuringAuthority(...args: Parameters<typeof originalRead>) {
    yield* originalRead(...args);
    if (args[0] !== 'member-admin' || ++actorReads !== 2 || saved) return;
    saved = true;
    const data = { memberId, email, role: 'member', personalAssistant: 'none',
      invitedBy: 'admin', invitationId: 'saved-during-check',
      expiresAt: new Date(clock.getTime() + 7 * 86_400_000).toISOString() };
    const record = { ...event('saved-during-check', `member-${memberId}`, 'member.invited'),
      silo: 'acme', commandId: input.commandId, principal: { kind: 'human', id: 'admin' },
      time: clock.toISOString(), data };
    const command = { event: record, expectedSequence: 0 };
    expect((await nats.store.append(command)).status).toBe('appended');
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(saveDuringAuthority);
  const writes = vi.spyOn(nats.store, 'append');
  const response = await request('POST');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ invitationId: 'saved-during-check', memberId });
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await records()).toHaveLength(1);
}
it('returns the caller receipt when their command is saved during the write access check',
  reconcilesSavedDuringFence);

async function renewsAtExpiry(offset: number) {
  expect((await request('POST')).statusCode).toBe(200);
  const first = (await records())[0]!;
  await members.apply(pgDb(dbs.queue), first.event, first.sequence);
  const data = memberInvitedDataSchema.parse(first.event.data);
  clock = new Date(Date.parse(data.expiresAt!) + offset);
  const body = { ...input, commandId: 'renew-at-expiry', expectedSequence: first.sequence };
  const response = await request('POST', body);
  expect(response.statusCode).toBe(200);
  const expectedExpiry = new Date(clock.getTime() + 7 * 86_400_000).toISOString();
  expect(response.json()).toMatchObject({ createdAt: clock.toISOString(),
    expiresAt: expectedExpiry });
  const after = await records();
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(first);
}
it.each([-1, 0, 1])('renews just before, at and after expiry with an injected clock (%s ms)',
  renewsAtExpiry);


async function refusesMalformedJson() {
  const session = { sub: 'admin', orgId: 'org-acme', roles: [],
    authTime: clock.getTime() / 1000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method: 'POST' as const, url: '/api/invitations', headers, payload: '{' };
  const response = await app.inject(options);
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ status: 'refused', reason: 'invalid_request' });
  expect(await records()).toEqual([]);
}
it('returns invalid_request for malformed request JSON', refusesMalformedJson);


async function prepareAcceptanceProjection() {
  await members.drop(pgDb(dbs.queue));
  const runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader, createLogger('test'));
  await runner.initialise(members);
  await dbs.queue.query("UPDATE projection_checkpoints SET sequence = 0 WHERE name = 'members'");
  await dbs.queue.query("DELETE FROM projection_events WHERE projection = 'members'");
  await runner.run(members);
  return runner;
}

async function createCompetingInvitations() {
  await prepareAcceptanceProjection();
  const first = await request('POST');
  const secondId = randomUUID();
  const secondInput = { ...input, memberId: secondId, commandId: 'invite-other' };
  const second = await request('POST', secondInput);
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  // Leave both invitations out of the read table to reproduce delayed background work.
  expect((await dbs.queue.query('SELECT member_id FROM members WHERE email = $1',
    [email])).rows).toEqual([]);
  const firstCommand = { memberId, invitationId: first.json<{ invitationId: string }>().invitationId,
    commandId: 'join-first', displayName: 'Person' };
  const secondCommand = { memberId: secondId,
    invitationId: second.json<{ invitationId: string }>().invitationId,
    commandId: 'join-second', displayName: 'Person' };
  return { firstCommand, secondCommand };
}

function acceptInvitation(payload: unknown) {
  const identity = { sub: 'person', orgId: 'org-acme', roles: [], email,
    emailVerified: true, authTime: clock.getTime() / 1000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, identity)}` };
  const options = { method: 'POST' as const, url: '/members/join', headers,
    payload: JSON.stringify(payload) };
  return app.inject(options);
}

async function assertOneJoined(firstId: string, secondId: string) {
  const first = await history(nats.store, `member-${firstId}`, 'acme');
  const second = await history(nats.store, `member-${secondId}`, 'acme');
  const rows = [...first, ...second];
  function isJoined(row: typeof rows[number]) {
    return row.event.type === 'member.joined';
  }
  expect(rows.filter(isJoined)).toHaveLength(1);
}

async function refusesOtherInvitationDuringFinalCheck() {
  const commands = await createCompetingInvitations();
  const read = nats.store.readStream.bind(nats.store);
  let competed = false;
  async function* joinOtherInvitation(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] !== 'member-admin' || competed) return;
    competed = true;
    const other = await acceptInvitation(commands.secondCommand);
    expect(other.statusCode).toBe(200);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(joinOtherInvitation);
  const response = await acceptInvitation(commands.firstCommand);
  expect(response.statusCode).toBe(409);
  await assertOneJoined(memberId, commands.secondCommand.memberId);
}
it('refuses a competing invitation accepted by the same account during the final access check',
  refusesOtherInvitationDuringFinalCheck);

async function racesDifferentInvitations() {
  const commands = await createCompetingInvitations();
  const appendEvent = nats.store.append.bind(nats.store);
  let attempts = 0;
  let release: () => void = pendingRelease;
  function pendingRelease() {}
  function setRelease(resolve: () => void) {
    release = resolve;
  }
  const barrier = new Promise<void>(setRelease);
  async function appendTogether(command: Parameters<typeof appendEvent>[0]) {
    attempts += 1;
    if (attempts === 2) release();
    await barrier;
    return appendEvent(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(appendTogether);
  const firstRequest = acceptInvitation(commands.firstCommand);
  const secondRequest = acceptInvitation(commands.secondCommand);
  const responses = await Promise.all([firstRequest, secondRequest]);
  function responseStatus(response: typeof responses[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(responseStatus);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  await assertOneJoined(memberId, commands.secondCommand.memberId);
}
it('stores one membership when the same account accepts two invitations at the same time',
  racesDifferentInvitations);

async function ignoresAlreadyProjectedHistory() {
  await prepareAcceptanceProjection();
  const created = await request('POST');
  expect(created.statusCode).toBe(200);
  const read = nats.store.readStream.bind(nats.store);
  const oldEvent = { ...event('old-member', 'member-unrelated', 'member.joined'),
    silo: 'acme', data: { memberId: 'unrelated', displayName: 'Unrelated',
      email: 'unrelated@example.test', role: 'member' } };
  async function* accumulatedHistory(...args: Parameters<typeof read>) {
    if (args[0] === 'member-*' && (args[1] ?? 1) === 1) {
      for (let index = 1; index <= 10_001; index += 1) {
        yield { sequence: index, event: oldEvent };
      }
      return;
    }
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(accumulatedHistory);
  const payload = { memberId,
    invitationId: created.json<{ invitationId: string }>().invitationId,
    commandId: 'accept-after-long-history', displayName: 'Person' };
  const response = await acceptInvitation(payload);
  expect(response.statusCode).toBe(200);
  expect(await records()).toHaveLength(2);
}
it('accepts without reading more than ten thousand already projected unrelated member events',
  ignoresAlreadyProjectedHistory);


async function checksProjectedIdentityAgainstEvents(kind: string) {
  const identity = { issuer: config.issuerUrl, sub: 'person' };
  const data = { memberId: 'existing-person', email: 'old-address@example.test',
    displayName: 'Person', role: 'member', invitationId: 'existing-invitation', identity };
  const record = { ...event(randomUUID(), 'member-existing-person', 'member.joined'),
    silo: 'acme', principal: { kind: 'human', id: 'person' }, data };
  expect((await nats.store.append({ event: record, expectedSequence: 0 })).status)
    .toBe('appended');
  const runner = await prepareAcceptanceProjection();
  // Keep the candidate in the read table but make its status disagree with its events.
  await dbs.queue.query("UPDATE members SET status = 'invited' WHERE member_id = $1",
    ['existing-person']);
  if (kind === 'removed') {
    const removal = { ...event(randomUUID(), record.subject, 'member.removed'),
      silo: 'acme', data: { memberId: 'existing-person', removedBy: 'admin' } };
    const expectedSequence = await nats.store.head(record.subject);
    expect((await nats.store.append({ event: removal, expectedSequence })).status)
      .toBe('appended');
  }
  const created = await request('POST');
  expect(created.statusCode).toBe(200);
  const payload = { memberId,
    invitationId: created.json<{ invitationId: string }>().invitationId,
    commandId: 'accept-with-projected-candidate', displayName: 'Person' };
  const response = await acceptInvitation(payload);
  if (kind === 'removed') {
    expect(response.statusCode).toBe(200);
    await runner.run(members);
    const bindings = await dbs.queue.query(
      `SELECT members.member_id FROM members JOIN member_identities USING (silo, member_id)
        WHERE members.status = 'joined' AND member_identities.sub = $1`, ['person']);
    expect(bindings.rows).toEqual([{ member_id: memberId }]);
  } else {
    expect(response.json()).toMatchObject({ status: 'refused', reason: 'already_member' });
    expect(await records()).toHaveLength(1);
  }
}
it.each(['active', 'removed'])(
  'checks a projected identity from another email against current events (%s)',
  checksProjectedIdentityAgainstEvents);

async function refusesIncompleteUnprojectedHistory() {
  const created = await request('POST');
  expect(created.statusCode).toBe(200);
  const read = nats.store.readStream.bind(nats.store);
  async function* incompleteHistory(...args: Parameters<typeof read>) {
    if (args[0] === 'member-*') return;
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(incompleteHistory);
  const payload = { memberId,
    invitationId: created.json<{ invitationId: string }>().invitationId,
    commandId: 'accept-with-incomplete-history', displayName: 'Person' };
  const response = await acceptInvitation(payload);
  expect(response.statusCode).toBe(503);
  expect(await records()).toHaveLength(1);
}
it('refuses an incomplete read of member events after the projection checkpoint',
  refusesIncompleteUnprojectedHistory);

const renewalIntervals = ['before_snapshot', 'after_snapshot', 'during_access', 'before_append'];

async function refusesRenewedInvitation(interval: string) {
  const initialInput = { ...input, role: 'admin', personalAssistant: 'provision' };
  const created = await request('POST', initialInput);
  expect(created.statusCode).toBe(200);
  const original = (await records())[0]!;
  const payload = { memberId,
    invitationId: created.json<{ invitationId: string }>().invitationId,
    commandId: 'accept-original', displayName: 'Person' };
  let renewed = false;
  let renewalId = '';
  async function renewInvitation() {
    if (renewed) return;
    renewed = true;
    const renewalInput = { ...input, commandId: 'renew-before-acceptance',
      expectedSequence: original.sequence };
    const response = await request('POST', renewalInput);
    expect(response.statusCode).toBe(200);
    renewalId = response.json<{ invitationId: string }>().invitationId;
  }
  const head = nats.store.head.bind(nats.store);
  async function renewAroundSnapshot(subject?: string, deadline?: number) {
    if (subject === 'member-*' && interval === 'before_snapshot') {
      await renewInvitation();
    }
    const position = await head(subject, deadline);
    if (subject === 'member-*' && interval === 'after_snapshot') {
      await renewInvitation();
    }
    return position;
  }
  const read = nats.store.readStream.bind(nats.store);
  async function* renewDuringAccess(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'member-admin' && interval === 'during_access') {
      await renewInvitation();
    }
  }
  const appendEvent = nats.store.append.bind(nats.store);
  async function renewBeforeAppend(command: Parameters<typeof appendEvent>[0]) {
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'member.joined' && interval === 'before_append') {
      await renewInvitation();
    }
    return appendEvent(command);
  }
  vi.spyOn(nats.store, 'head').mockImplementation(renewAroundSnapshot);
  vi.spyOn(nats.store, 'readStream').mockImplementation(renewDuringAccess);
  vi.spyOn(nats.store, 'append').mockImplementation(renewBeforeAppend);
  const response = await acceptInvitation(payload);
  expect(renewed).toBe(true);
  expect(response.statusCode).toBe(409);
  vi.restoreAllMocks();
  const beforeRetry = await records();
  expect(beforeRetry).toHaveLength(2);
  expect(beforeRetry[1]?.event.data).toMatchObject({ invitationId: renewalId,
    role: 'member', personalAssistant: 'none' });
  const oldRetry = await acceptInvitation(payload);
  expect(oldRetry.json()).toMatchObject({ status: 'refused', reason: 'unknown_invitation' });
  expect(await records()).toEqual(beforeRetry);
  const currentPayload = { ...payload, invitationId: renewalId, commandId: 'accept-renewal' };
  expect((await acceptInvitation(currentPayload)).statusCode).toBe(200);
  const saved = await records();
  expect(saved).toHaveLength(3);
  expect(saved[2]?.event.data).toMatchObject({ invitationId: renewalId,
    role: 'member', personalAssistant: 'none' });
  await prepareAcceptanceProjection();
  const projected = await dbs.queue.query('SELECT role, status FROM members WHERE member_id = $1',
    [memberId]);
  expect(projected.rows).toEqual([{ role: 'member', status: 'joined' }]);
}
it.each(renewalIntervals)('refuses a superseded Admin invitation renewed %s',
  refusesRenewedInvitation);

async function boundsRefusalsPerDay() {
  const attempts = [];
  for (let index = 0; index < 12; index += 1) {
    const attempt = { ...input, commandId: `refused-command-${index}` };
    attempts.push(request('POST', attempt, 'member'));
  }
  const responses = await Promise.all(attempts);
  for (const response of responses) {
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      status: 'refused', reason: 'access_refused', recorded: true,
    });
  }
  const subject = `memberaudit-${memberId}`;
  const firstDay = await history(nats.store, subject, 'acme');
  expect(firstDay).toHaveLength(1);
  expect(firstDay[0]?.event).toMatchObject({ type: 'member.command_refused',
    principal: { kind: 'human', id: 'member' }, data: {
      memberId, operation: 'invite', reason: 'access_refused',
    } });
  expect(JSON.stringify(firstDay)).not.toContain(email);
  clock = new Date('2026-10-02T12:00:00Z');
  expect((await request('POST', input, 'member')).statusCode).toBe(403);
  expect(await history(nats.store, subject, 'acme')).toHaveLength(2);
  expect(await records()).toEqual([]);
}
it('keeps at most one safe refusal per person, target, operation, reason and UTC day',
  boundsRefusalsPerDay);

function changeRead(sub = 'admin', orgId = 'org-acme', commandId = input.commandId) {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const url = `/api/invitations/${memberId}/command-changes/${commandId}`;
  const options = { method: 'GET' as const, url, headers };
  return app.inject(options);
}
async function readsOriginalChange() {
  expect((await changeRead()).statusCode).toBe(404);
  const created = (await request('POST')).json<{ invitationId: string; sequence: number }>();
  const response = await changeRead();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'recorded', commandId: input.commandId,
    type: 'member.invited', sequence: created.sequence, recordedAt: clock.toISOString(),
    result: { memberId, invitationId: created.invitationId, email,
      link: `https://app.example.test/join/${memberId}/${created.invitationId}`,
      delivery: 'link_only', role: 'member', personalAssistant: 'none' },
    projection: { content: 'applying', iam: 'not_required' } });
  expect((await changeRead('owner')).statusCode).toBe(404);
  expect((await changeRead('admin', 'other-org')).statusCode).toBe(403);
  const demotion = { memberId: 'admin', previousRole: 'admin', newRole: 'member',
    changedBy: 'owner' };
  await append('member-admin', 'member.role_changed', demotion, true);
  const minimal = (await changeRead()).json<Record<string, unknown>>();
  expect(minimal).toMatchObject({ status: 'recorded', sequence: created.sequence });
  expect(minimal).not.toHaveProperty('result');
  await append('member-admin', 'member.removed', { memberId: 'admin', removedBy: 'owner' }, true);
  expect((await changeRead()).statusCode).toBe(403);
  expect(await records()).toHaveLength(1);
}
it('reads the original actor and command from events and limits receipts after demotion',
  readsOriginalChange);

async function keepsRefusalWhenAuditFails() {
  function unavailableAudit() {
    const result = { status: 'unavailable' as const,
      cause: new Error('Private upstream diagnostic') };
    return Promise.resolve(result);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(unavailableAudit);
  const response = await request('POST', input, 'member');
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused', reason: 'access_refused', recorded: false });
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toEqual([]);
  expect(await records()).toEqual([]);
}
it('returns the real business refusal when its audit append fails', keepsRefusalWhenAuditFails);

async function recordsWrongAccount() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  const session = { sub: 'another-account', orgId: 'org-acme', roles: [],
    email: 'private-address@example.test', emailVerified: true,
    authTime: clock.getTime() / 1000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const payload = { memberId, invitationId: created.invitationId,
    commandId: 'wrong-account-join', displayName: 'Private name' };
  const options = { method: 'POST' as const, url: '/members/join', headers, payload };
  const response = await app.inject(options);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', reason: 'wrong_identity', recorded: true });
  const refusals = await history(nats.store, `memberaudit-${memberId}`, 'acme');
  expect(refusals).toHaveLength(1);
  expect(refusals[0]?.event.data).toMatchObject({ invitationId: created.invitationId,
    operation: 'join', reason: 'wrong_identity' });
  const safeRecord = JSON.stringify(refusals);
  expect(safeRecord).not.toContain('private-address');
  expect(safeRecord).not.toContain('Private name');
  expect(safeRecord).not.toContain('another-account');
  clock = new Date('2026-10-08T12:00:00Z');
  const expiredResponse = await app.inject(options);
  expect(expiredResponse.json()).toEqual(response.json());
  expect(await records()).toHaveLength(1);
}
it('records a wrong-account annotation without the other account details or a join',
  recordsWrongAccount);

function organisationHistory(sub = 'admin', orgId = 'org-acme', url = '/api/org/history') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method: 'GET' as const, url, headers };
  return app.inject(options);
}
async function rebuildsSafeInvitationHistory() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  await request('POST', input, 'member');
  const db = pgDb(dbs.queue);
  const logger = createLogger('invitation-audit-test');
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(auditTrail);
  await runner.rebuild(auditTrail);
  const before = await organisationHistory();
  expect(before.statusCode).toBe(200);
  const records = before.json<{ rows: { records: unknown[] }[] }>();
  const summaries: unknown[] = [];
  for (const row of records.rows) summaries.push(...row.records);
  expect(summaries).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'member.invited', memberId,
      invitationId: created.invitationId, role: 'member', recordedAt: clock.toISOString() }),
    expect.objectContaining({ type: 'member.command_refused', memberId,
      operation: 'invite', reason: 'Request refused', recordedAt: clock.toISOString() }),
  ]));
  expect(before.body).not.toContain(email);
  expect((await organisationHistory('member')).statusCode).toBe(403);
  expect((await organisationHistory('admin', 'other-org')).statusCode).toBe(403);
  await rebuildAuditProjection(db, nats.store, logger, { verify: true });
  expect((await organisationHistory()).json()).toEqual(before.json());
}
it('returns safe invitation and refusal history and rebuilds the same authorised read',
  rebuildsSafeInvitationHistory);

async function savedInvitationWinsOverRefusal() {
  await request('POST', input, 'member');
  const refused = await changeRead('member');
  expect(refused.json()).toMatchObject({ status: 'refused', reason: 'access_refused' });
  const promotion = { memberId: 'member', previousRole: 'member', newRole: 'admin',
    changedBy: 'owner' };
  await append('member-member', 'member.role_changed', promotion, true);
  expect((await request('POST', input, 'member')).statusCode).toBe(200);
  expect((await changeRead('member')).json()).toMatchObject({ status: 'recorded',
    commandId: input.commandId, type: 'member.invited' });
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toHaveLength(1);
  expect(await records()).toHaveLength(1);
}
it('prefers a saved invitation over earlier refusal evidence for the same command',
  savedInvitationWinsOverRefusal);

async function refusesAnotherCreatorsReceipt() {
  const created = await request('POST');
  expect(created.statusCode).toBe(200);
  const appendSpy = vi.spyOn(nats.store, 'append');
  const legacy = await request('GET', undefined, 'owner');
  const full = await changeRead('owner');
  expect(legacy.statusCode).toBe(404);
  expect(legacy.json()).toEqual({ status: 'not_found' });
  expect(full.statusCode).toBe(404);
  expect(full.json()).toEqual({ status: 'not_found', commandId: input.commandId });
  expect((await request('GET')).json()).toEqual(created.json());
  expect((await changeRead()).statusCode).toBe(200);
  expect(appendSpy).not.toHaveBeenCalled();
}
it('returns no original command receipt to another current admin on either route',
  refusesAnotherCreatorsReceipt);

async function refusesNonHumanCreator(kind: 'agent' | 'system') {
  expect((await request('POST')).statusCode).toBe(200);
  const read = nats.store.readStream.bind(nats.store);
  async function* changePrincipal(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (args[0] === `member-${memberId}`) {
        const principal = { kind, id: 'admin' };
        const event = { ...row.event, principal };
        yield { ...row, event };
      } else {
        yield row;
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changePrincipal);
  const appendSpy = vi.spyOn(nats.store, 'append');
  expect((await request('GET')).statusCode).toBe(404);
  expect((await changeRead()).statusCode).toBe(404);
  expect(appendSpy).not.toHaveBeenCalled();
}
it.each(['agent', 'system'] as const)(
  'refuses a saved invitation with a %s principal even when its id matches',
  refusesNonHumanCreator);

async function prepareAuditProjection() {
  const db = pgDb(dbs.queue);
  const logger = createLogger('invitation-audit-test');
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(auditTrail);
  await runner.rebuild(auditTrail);
  return runner;
}

async function neverCachesInvitationAudit() {
  expect((await request('POST')).statusCode).toBe(200);
  expect((await request('POST', input, 'member')).statusCode).toBe(403);
  await prepareAuditProjection();
  const response = await organisationHistory();
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain('member.invited');
  expect(response.body).toContain('member.command_refused');
  expect(response.headers['cache-control']).toBe('no-store');
}
it('sets no-store on successful invitation and refusal audit history', neverCachesInvitationAudit);

async function neverCachesAuditError(kind: string, status: number) {
  await prepareAuditProjection();
  let response;
  if (kind === 'no_session') {
    const options = { method: 'GET' as const, url: '/api/org/history' };
    response = await app.inject(options);
  } else if (kind === 'unavailable') {
    binding.apiUrl = 'http://127.0.0.1:1';
    response = await organisationHistory();
  } else if (kind === 'invalid_request') {
    const session = { sub: 'admin', orgId: 'org-acme', roles: [],
      authTime: 1790856000, exp: 2000000000 };
    const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
    const options = { method: 'GET' as const, url: '/api/org/history?before=bad', headers };
    response = await app.inject(options);
  } else if (kind === 'foreign') {
    response = await organisationHistory('admin', 'other-org');
  } else {
    response = await organisationHistory('member');
  }
  expect(response.statusCode).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
}
it.each([
  ['no_session', 401], ['member', 403], ['foreign', 403],
  ['unavailable', 503], ['invalid_request', 400],
])('sets no-store on an audit %s response', neverCachesAuditError);

async function deniesAdminInOpenFga() {
  // Leave the saved role unchanged to test a disagreement with the permission service.
  const data = { memberId: 'admin', previousRole: 'admin', newRole: 'member',
    changedBy: 'owner' };
  const record = { ...event(randomUUID(), 'member-admin', 'member.role_changed'),
    silo: 'acme', data };
  await memberAuthorisation(binding).handler.handle(record, pgDb(dbs.queue));
}

async function refusesReadWithoutCurrentPermissions(route: string, failure: string,
  status: number) {
  expect((await request('POST')).statusCode).toBe(200);
  await prepareAuditProjection();
  if (failure === 'denied') {
    await deniesAdminInOpenFga();
  } else if (failure === 'unavailable') {
    binding.apiUrl = 'http://127.0.0.1:1';
  } else {
    const change = { memberId: 'admin', previousRole: 'admin', newRole: 'admin',
      changedBy: 'owner' };
    await append('member-admin', 'member.role_changed', change);
    expect((await memberAuthorisation(binding).check('admin', 'admin')).allowed).toBe(true);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  let response;
  if (route === 'audit') {
    response = await organisationHistory();
  } else if (route === 'legacy') {
    response = await request('GET');
  } else {
    response = await changeRead();
  }
  expect(response.statusCode).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain('invitationId');
  expect(response.body).not.toContain(email);
  expect(appendSpy).not.toHaveBeenCalled();
}
it.each([
  ['legacy', 'denied', 403], ['legacy', 'unavailable', 503], ['legacy', 'unapplied', 503],
  ['recovery', 'denied', 403], ['recovery', 'unavailable', 503], ['recovery', 'unapplied', 503],
  ['audit', 'denied', 403], ['audit', 'unavailable', 503], ['audit', 'unapplied', 503],
])('refuses %s reads when current OpenFGA access is %s', refusesReadWithoutCurrentPermissions);

async function refusesAuditAuthorityLossDuringRead() {
  expect((await request('POST')).statusCode).toBe(200);
  await prepareAuditProjection();
  const db = pgDb(dbs.queue);
  let removed = false;
  async function query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
    const result = await db.query<Row>(sql, parameters);
    if (sql.startsWith('SELECT * FROM audit_entries') && !removed) {
      removed = true;
      const data = { memberId: 'admin', removedBy: 'owner' };
      await append('member-admin', 'member.removed', data);
    }
    return result;
  }
  const controlledDb = { query };
  await app.close();
  app = server(controlledDb);
  const response = await organisationHistory();
  expect(removed).toBe(true);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.body).not.toContain('member.invited');
}
it('refuses organisation history when the admin is removed during the database read',
  refusesAuditAuthorityLossDuringRead);

async function readsAuditWithoutWrites() {
  expect((await request('POST')).statusCode).toBe(200);
  expect((await request('POST', input, 'member')).statusCode).toBe(403);
  await prepareAuditProjection();
  const appendSpy = vi.spyOn(nats.store, 'append');
  const querySpy = vi.spyOn(dbs.queue, 'query');
  expect((await organisationHistory()).statusCode).toBe(200);
  expect((await organisationHistory('member')).statusCode).toBe(403);
  expect(appendSpy).not.toHaveBeenCalled();
  for (const call of querySpy.mock.calls) {
    expect(call[0]).toMatch(/^SELECT /u);
  }
  expect(await records()).toHaveLength(1);
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toHaveLength(1);
}
it('appends nothing and writes no projection during successful or refused audit GETs',
  readsAuditWithoutWrites);

async function limitsRefusalRecovery(actor: string, kind: 'human' | 'agent' | 'system',
  operation: 'invite' | 'join') {
  const data = { memberId, originalCommandDigest: refusalDigest(input.commandId), operation,
    inputDigest: 'a'.repeat(64), reason: 'access_refused' };
  const record = { ...event(randomUUID(), `memberaudit-${memberId}`, 'member.command_refused'),
    silo: 'acme', principal: { kind, id: actor }, data };
  const command = { event: record, expectedSequence: 0 };
  expect((await nats.store.append(command)).status).toBe('appended');
  const appendSpy = vi.spyOn(nats.store, 'append');
  const response = await changeRead();
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ status: 'not_found', commandId: input.commandId });
  expect(appendSpy).not.toHaveBeenCalled();
}
it.each([
  ['owner', 'human', 'invite'], ['admin', 'agent', 'invite'],
  ['admin', 'system', 'invite'], ['admin', 'human', 'join'],
] as const)('does not recover refusal evidence for %s/%s/%s', limitsRefusalRecovery);

async function excludesInvalidInvitationRequestsFromAudit(body: unknown) {
  const appendSpy = vi.spyOn(nats.store, 'append');
  expect((await request('POST', body)).statusCode).toBe(400);
  expect(appendSpy).not.toHaveBeenCalled();
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toEqual([]);
}
it.each(invalidBodies)('records no refusal audit for invalid invitation input %#',
  excludesInvalidInvitationRequestsFromAudit);

async function excludesUntrustedInvitationRequestsFromAudit(orgId: string, origin: string) {
  const appendSpy = vi.spyOn(nats.store, 'append');
  expect((await request('POST', input, 'admin', orgId, origin)).statusCode).toBe(403);
  expect(appendSpy).not.toHaveBeenCalled();
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toEqual([]);
}
it.each([
  ['other-org', 'https://app.example.test'],
  ['org-acme', 'https://evil.example.test'], ['org-acme', 'https://app.example.test/'],
])('records no refusal audit for an untrusted invitation request (%s, %s)',
  excludesUntrustedInvitationRequestsFromAudit);

async function excludesInvalidJoinHistoryFromAudit() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  const read = nats.store.readStream.bind(nats.store);
  async function* wrongSubject(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (args[0] === `member-${memberId}`) {
        const event = { ...row.event, subject: 'member-another-person' };
        yield { ...row, event };
      } else {
        yield row;
      }
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(wrongSubject);
  const appendSpy = vi.spyOn(nats.store, 'append');
  const payload = { memberId, invitationId: created.invitationId,
    commandId: 'invalid-history-join', displayName: 'Person' };
  const response = await acceptInvitation(payload);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', reason: 'invalid_history' });
  expect(appendSpy).not.toHaveBeenCalled();
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toEqual([]);
}
it('records neither a join nor refusal audit for invalid invitation history',
  excludesInvalidJoinHistoryFromAudit);

function wrongAccountJoin(payload: unknown, sub = 'another-account', orgId = 'org-acme') {
  const session = { sub, orgId, roles: [], email: 'private-address@example.test',
    emailVerified: true, authTime: clock.getTime() / 1000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method: 'POST' as const, url: '/members/join', headers,
    payload: JSON.stringify(payload) };
  return app.inject(options);
}

async function boundsJoinRefusalsPerDay() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  const attempts = [];
  for (let index = 0; index < 12; index += 1) {
    const payload = { memberId, invitationId: created.invitationId,
      commandId: `wrong-account-${index}`, displayName: 'Private name' };
    attempts.push(wrongAccountJoin(payload));
  }
  const responses = await Promise.all(attempts);
  for (const response of responses) {
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', reason: 'wrong_identity', recorded: true });
  }
  const subject = `memberaudit-${memberId}`;
  const firstDay = await history(nats.store, subject, 'acme');
  expect(firstDay).toHaveLength(1);
  expect(firstDay[0]?.event.data).toMatchObject({ operation: 'join', reason: 'wrong_identity' });
  const payload = { memberId, invitationId: created.invitationId,
    commandId: 'wrong-account-next-day', displayName: 'Private name' };
  clock = new Date('2026-10-02T12:00:00Z');
  expect((await wrongAccountJoin(payload)).json()).toEqual(responses[0]!.json());
  expect(await history(nats.store, subject, 'acme')).toHaveLength(2);
  expect((await wrongAccountJoin(payload, 'different-account')).statusCode).toBe(409);
  expect(await history(nats.store, subject, 'acme')).toHaveLength(3);
  expect(await records()).toHaveLength(1);
}
it('keeps one concurrent join refusal per account and UTC day across different command ids',
  boundsJoinRefusalsPerDay);

async function excludesForeignJoinFromAudit() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  const payload = { memberId, invitationId: created.invitationId,
    commandId: 'foreign-join', displayName: 'Private name' };
  const appendSpy = vi.spyOn(nats.store, 'append');
  expect((await wrongAccountJoin(payload, 'admin', 'other-org')).statusCode).toBe(403);
  expect(appendSpy).not.toHaveBeenCalled();
  expect(await history(nats.store, `memberaudit-${memberId}`, 'acme')).toEqual([]);
}
it('records no refusal audit for an acceptance from another organisation',
  excludesForeignJoinFromAudit);

async function rebuildsWrongAccountHistoryWithoutForeignRecords() {
  const created = (await request('POST')).json<{ invitationId: string }>();
  const payload = { memberId, invitationId: created.invitationId,
    commandId: 'wrong-account-rebuild', displayName: 'Private name' };
  expect((await wrongAccountJoin(payload)).statusCode).toBe(409);
  const data = { memberId, originalCommandDigest: refusalDigest(input.commandId),
    operation: 'invite', inputDigest: 'a'.repeat(64), reason: 'access_refused' };
  const foreign = { ...event('foreign-refusal', `memberaudit-${memberId}`, 'member.command_refused'),
    silo: 'other-silo', data };
  await nats.seed([foreign]);
  await prepareAuditProjection();
  const before = await organisationHistory();
  expect(before.statusCode).toBe(200);
  expect(before.headers['cache-control']).toBe('no-store');
  expect(before.body).toContain('member.command_refused');
  expect(before.body).toContain('"operation":"join"');
  for (const privateValue of [email, 'private-address', 'Private name', 'another-account',
    'inputDigest', 'foreign-refusal', 'other-silo']) {
    expect(before.body).not.toContain(privateValue);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  const logger = createLogger('invitation-audit-test');
  await rebuildAuditProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
  const after = await organisationHistory();
  expect(after.statusCode).toBe(200);
  expect(after.json()).toEqual(before.json());
  expect(appendSpy).not.toHaveBeenCalled();
}
it('rebuilds safe wrong-account HTTP history and excludes foreign refusal records',
  rebuildsWrongAccountHistoryWithoutForeignRecords);

async function refusesMalformedRefusalReplay() {
  expect((await request('POST')).statusCode).toBe(200);
  await prepareAuditProjection();
  const before = await organisationHistory();
  expect(before.statusCode).toBe(200);
  const malformed = { ...event('malformed-refusal', `memberaudit-${memberId}`,
    'member.command_refused'), silo: 'acme', data: { memberId, reason: 'Private name' } };
  await nats.seed([malformed]);
  const logger = createLogger('invitation-audit-test');
  await expect(rebuildAuditProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true }))
    .rejects.toThrow();
  const after = await organisationHistory();
  expect(after.statusCode).toBe(200);
  expect(after.json()).toEqual(before.json());
  expect(after.body).not.toContain('malformed-refusal');
  expect(after.body).not.toContain('Private name');
}
it('refuses malformed refusal replay and retains the previously authorised HTTP history',
  refusesMalformedRefusalReplay);


async function refusesForeignAuditSession(url: string) {
  const response = await organisationHistory('admin', 'other-org', url);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(response.headers['cache-control']).toBe('no-store');
}
it.each(['/api/org/history', '/api/conversations/private-chat/history'])(
  'refuses an extra sign-in identity from another organisation on %s', refusesForeignAuditSession,
);
