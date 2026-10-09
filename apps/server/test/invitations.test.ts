import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { memberInvitedDataSchema } from '@opencrane/events';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme',
  extraIdentities: [{ issuer: 'https://idp.example.test', subject: 'admin' }] });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let app: ReturnType<typeof buildServer>;
const email = 'person@example.test';
const memberId = 'invitation-a1d1081e54c9b8d781a90d17a3fac2159150eb7b0341f62f76de031fb84dd94b';
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
function server() {
  const options = { silo: 'acme', store: nats.store, binding,
    feed: { memberId: resolveMember } };
  return buildServer(config, { invitationEmail: options });
}
async function append(subject: string, type: string, data: unknown, apply = false) {
  const record = { ...event(randomUUID(), subject, type), silo: 'acme', data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply) await memberAuthorisation(binding).handler.handle(record, pgDb(dbs.queue));
}
async function fixture() {
  nats = await natsFixture();
  binding = await createStore(fga.apiUrl, 'acme');
  for (const role of ['owner', 'admin', 'member']) {
    const data = { memberId: role, displayName: role, email: `${role}@example.test`, role };
    await append(`member-${role}`, 'member.joined', data, true);
  }
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
it('refuses a body id that differs from the email invitation id', refusesBodyId);
async function refusesActiveTarget() {
  const data = { memberId: 'existing', displayName: 'Person', email, role: 'member' };
  await append('member-existing', 'member.joined', data);
  expect((await request('POST')).json()).toMatchObject({ reason: 'already_member' });
  expect(await records()).toEqual([]);
}
it('refuses an active target from events even without its projection', refusesActiveTarget);
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
    const replacement = { ...data, invitationId: 'expired', expiresAt: '2020-01-01T00:00:00Z' };
    await append(`member-${memberId}`, 'member.invited', replacement);
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
it.each([['role', 'admin'], ['personalAssistant', 'provision'], ['expectedSequence', 1]])(
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
  expect([403, 503]).toContain(response.statusCode);
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
  expect([200, 503]).toContain(first.statusCode);
  expect([200, 503]).toContain(second.statusCode);
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
  const data = { memberId: 'existing', email, role: 'member', invitedBy: 'admin',
    invitationId: 'pending', invitedIdentity: { issuer: config.issuerUrl, sub: 'person' } };
  await append('member-existing', 'member.invited', data);
  const read = nats.store.readStream.bind(nats.store);
  let actorReads = 0;
  async function* joinDuringAuthority(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] !== 'member-admin' || ++actorReads !== 2) return;
    const joined = { memberId: 'existing', email, role: 'member', displayName: 'Person' };
    await append('member-existing', 'member.joined', joined);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(joinDuringAuthority);
  expect((await request('POST')).statusCode).toBe(503);
  expect(await records()).toEqual([]);
}
it('refuses a matching pending target that joins during the write check', refusesTargetJoining);
