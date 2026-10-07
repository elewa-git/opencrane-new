import { deriveAdmission } from '../src/members/admission.ts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { groups, members, pgDb, ProjectionRunner, rebuildGroupProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let count = 0;
async function append(subject: string, type: string, data: unknown, apply = true, silo = 'acme') {
  const record = { ...event(`group-fixture-${++count}`, subject, type), silo, data, correlation: {}, principal: { kind: 'human' as const, id: 'owner' } };
  const result = await nats.store.append({ event: record, expectedSequence: await nats.store.head(subject) });
  expect(result.status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) await auth.handler.handle(record, pgDb(dbs.queue));
  return record;
}
function request(method: 'GET' | 'POST', url = '/api/groups', payload?: unknown, sub = 'idp-owner', orgId = 'org-acme') {
  return app.inject({ method, url, ...(payload ? { payload: JSON.stringify(payload) } : {}), headers: {
    origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 })}`,
  } });
}
const initialiseGroupsFixture = async () => {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('groups-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(groups);
  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member'], ['admin', 'admin']] as const) {
    await append(`member-${memberId}`, 'member.invited', { memberId, email: `${memberId}@example.test`, role, invitedBy: 'owner', invitationId: `invite-${memberId}`, invitedIdentity: { issuer: config.issuerUrl, sub: `idp-${memberId}` } });
    const joined = { ...event(`group-fixture-${++count}`, `member-${memberId}`, 'member.joined'), silo: 'acme', correlation: {}, principal: { kind: 'human' as const, id: `idp-${memberId}` }, data: { memberId, email: `${memberId}@example.test`, displayName: memberId, role, invitationId: `invite-${memberId}` } };
    expect((await nats.store.append({ event: joined, expectedSequence: await nats.store.head(joined.subject) })).status).toBe('appended');
    await auth.handler.handle(joined, db);
  }
  await append('member-identity-owner', 'member.joined', { memberId: 'identity-owner',
    email: 'identity-owner@example.test', displayName: 'Invitation admin', role: 'admin' });
  await runner.run(members);
  const invitationEmail = { silo: 'acme', store: nats.store, binding,
    feed: { memberId: resolveMemberId } };
  app = buildServer(config, { invitationEmail, groups: { silo: 'acme', store: nats.store, db, binding,
    feed: { memberId: resolveMemberId } } });
};
beforeAll(initialiseGroupsFixture, 120_000);
const closeGroupsFixture = async () => {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
};
afterAll(closeGroupsFixture);
const createsGroupOnce = async () => {
  const spy = vi.spyOn(nats.store, 'append');
  const input = { commandId: 'create-sales', groupId: 'sales', name: 'Sales' };
  const response = await request('POST', '/api/groups', input);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'appended', groupId: 'sales' });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]?.[0].expectedSequence).toBe(0);
  expect((await request('POST', '/api/groups', input)).json()).toEqual(response.json());
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
};
it('an owner creates a flat group with one durable event and retries the same command', createsGroupOnce);
const listsMembershipWithoutPrivateAccess = async () => {
  expect((await request('POST', '/api/groups', { commandId: 'create-support', groupId: 'support', name: 'Support' }, 'idp-admin')).statusCode).toBe(200);
  expect((await request('POST', '/api/groups/support', { action: 'add', commandId: 'add-bob', memberId: 'bob' }, 'idp-admin')).statusCode).toBe(200);
  await runner.run(members);
  await runner.run(groups);
  const response = await request('GET', '/api/groups/support');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ rows: [{ groupId: 'support', name: 'Support', membershipSource: 'local',
    members: [{ memberId: 'bob', displayName: 'bob', membershipSource: 'local' }],
    access: { source: 'group_membership', conversationAccess: false, personalMemoryAccess: false } }] });
};
it('an admin adds a silo member and the list explains group membership without private-content rights', listsMembershipWithoutPrivateAccess);
const preservesDirectoryMembership = async () => {
  await append('team-directory', 'team.created', { teamId: 'directory', name: 'Directory', createdBy: 'idp', membershipSource: 'identity_provider' });
  await append('team-directory', 'team.member_added', { teamId: 'directory', memberId: 'bob', addedBy: 'idp', membershipSource: 'identity_provider' });
  await runner.run(groups);
  expect((await request('GET', '/api/groups/directory')).json()).toMatchObject({ rows: [{ membershipSource: 'identity_provider', members: [{ membershipSource: 'identity_provider' }] }] });
  expect((await request('POST', '/api/groups/directory', { action: 'remove', commandId: 'remove-directory', memberId: 'bob' })).statusCode).toBe(403);
};
it('preserves supplied identity-provider membership and refuses local edits', preservesDirectoryMembership);
const rebuildsRemovedMembership = async () => {
  expect((await request('POST', '/api/groups/support', { action: 'remove', commandId: 'remove-bob', memberId: 'bob' })).statusCode).toBe(200);
  await runner.run(groups);
  for (const subject of ['team-support', 'team-sales']) for await (const row of nats.store.readStream(subject)) { await auth.handler.handle(row.event, pgDb(dbs.queue)); }
  expect((await auth.team('bob', 'support')).allowed).toBe(false);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'acme', nats.reader, { verifyAgainst: auth.binding });
  expect((await rebuilt.team('bob', 'support')).allowed).toBe(false);
  expect((await auth.team('bob', 'directory')).allowed).toBe(true);
  expect((await rebuilt.team('bob', 'directory')).allowed).toBe(true);
  const before = (await request('GET', '/api/groups/support')).json<unknown>();
  await rebuildGroupProjection(pgDb(dbs.queue), nats.reader, createLogger('group-replay', { level: 'silent' }), { verify: true });
  expect((await request('GET', '/api/groups/support')).json()).toEqual(before);
};
it('rebuilds the same group view and OpenFGA membership after removal', rebuildsRemovedMembership);
const refusesInvalidGroupCommand = async (_name: string, sub: string, orgId: string, input: unknown, code: number) => {
  const before = await nats.store.head();
  expect((await request('POST', '/api/groups', input, sub, orgId)).statusCode).toBe(code);
  expect(await nats.store.head()).toBe(before);
};
it.each([
  ['non-admin', 'idp-bob', 'org-acme', { commandId: 'member-create', groupId: 'forbidden', name: 'No' }, 403],
  ['foreign silo', 'idp-owner', 'other', { commandId: 'foreign-create', groupId: 'forbidden', name: 'No' }, 403],
  ['hierarchy', 'idp-owner', 'org-acme', { commandId: 'nested-create', groupId: 'forbidden', name: 'No', parentId: 'support' }, 400],
  ['unsafe id', 'idp-owner', 'org-acme', { commandId: 'wild-create', groupId: '*', name: 'No' }, 400],
])('refuses %s without appending', refusesInvalidGroupCommand);
const refusesRevokedMembers = async () => {
  await append('member-bob', 'member.removed', { memberId: 'bob', removedBy: 'owner' }, false);
  expect((await request('POST', '/api/groups/support', { action: 'add', commandId: 'readd-inactive', memberId: 'bob' })).statusCode).toBe(403);
  await append('member-admin', 'member.role_changed', { memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner' }, false);
  expect((await request('POST', '/api/groups', { commandId: 'revoked-admin', groupId: 'revoked', name: 'Revoked' }, 'idp-admin')).statusCode).toBe(403);
};
it('refuses inactive targets and a revoked administrator before IAM catches up', refusesRevokedMembers);

const reconcilesGroupChange = async () => {
  const response = await request('GET', '/api/groups/sales/changes/create-sales');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'appended', groupId: 'sales', projection: { content: 'current', iam: 'current' } });
};
it('reconciles an accepted command by its original change reference', reconcilesGroupChange);
const serialisesGroupCommands = async (same: boolean) => {
  const groupId = same ? 'same-race' : 'opposite-race';
  expect((await request('POST', '/api/groups', { commandId: `create-${groupId}`, groupId, name: groupId })).statusCode).toBe(200);
  const original = nats.store.readStream.bind(nats.store);
  let reads = 0;
  let release!: () => void;
  function captureRelease(resolve: () => void) {
    release = resolve;
  }
  const barrier = new Promise<void>(captureRelease);
  async function* readTogether(...args: Parameters<typeof original>) {
    const [subject, from, deadline] = args;
    if (subject !== `team-${groupId}` || reads >= 2) { yield* original(subject, from, deadline); return; }
    const rows = [];
    for await (const row of original(subject, from, deadline)) rows.push(row);
    if (++reads === 2) release();
    await barrier;
    yield* rows;
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(readTogether);
  const commands = [{ action: 'add', commandId: `add-${groupId}`, memberId: 'owner' },
    { action: same ? 'add' : 'remove', commandId: same ? `add-${groupId}` : `remove-${groupId}`, memberId: 'owner' }];
  try {
    function sendCommand(body: (typeof commands)[number]) {
      return request('POST', `/api/groups/${groupId}`, body);
    }
    const pendingResponses = commands.map(sendCommand);
    const responses = await Promise.all(pendingResponses);
    function responseCode(response: (typeof responses)[number]) {
      return response.statusCode;
    }
    const codes = responses.map(responseCode);
    codes.sort();
    expect(codes).toEqual(same ? [200, 200] : [200, 409]);
    const rows = []; for await (const row of original(`team-${groupId}`)) rows.push(row);
    expect(rows).toHaveLength(2);
    if (!same) {
      function isConflict(response: (typeof responses)[number]) {
        return response.statusCode === 409;
      }
      const loserIndex = responses.findIndex(isConflict);
      const loser = commands[loserIndex]!;
      expect((await request('POST', `/api/groups/${groupId}`, loser)).statusCode).toBe(200);
      const ordered: StoredEvent[] = [];
      for await (const row of original(`team-${groupId}`)) ordered.push(row);
      function eventType(row: (typeof ordered)[number]) {
        return row.event.type;
      }
      const eventTypes = ordered.map(eventType);
      const expected = loser.action === 'add'
        ? ['team.created', 'team.member_removed', 'team.member_added']
        : ['team.created', 'team.member_added', 'team.member_removed'];
      expect(eventTypes).toEqual(expected);
    }
  } finally { spy.mockRestore(); }
};
it.each([false, true])('serialises racing membership commands on one group stream (same command: %s)', serialisesGroupCommands);
const refusesUnavailableOrForeignAuthority = async () => {
  await append('team-foreign', 'team.created', { teamId: 'foreign', name: 'Foreign', createdBy: 'owner' }, false, 'other');
  const before = await nats.store.head();
  expect((await request('POST', '/api/groups/foreign', { action: 'add', commandId: 'foreign-add', memberId: 'owner' })).statusCode).toBe(503);
  expect(await nats.store.head()).toBe(before);
  await fga.pause();
  try { expect((await request('GET')).statusCode).toBe(503); }
  finally { await fga.resume(); }
};
it('fails closed when IAM is unavailable and when the same group id belongs to a foreign silo', refusesUnavailableOrForeignAuthority);
const usesExistingPayingGroupCeiling = async () => {
  const { BudgetActor, payingGroupAuthority, priceTableId } = await import('@opencrane/models');
  expect((await request('POST', '/api/groups', { commandId: 'create-finance', groupId: 'finance', name: 'Finance' })).statusCode).toBe(200);
  expect((await request('POST', '/api/groups/finance', { action: 'add', commandId: 'join-finance', memberId: 'owner' })).statusCode).toBe(200);
  for await (const row of nats.store.readStream('team-finance')) await auth.handler.handle(row.event, pgDb(dbs.queue));
  await runner.run(groups);
  expect((await request('GET', '/api/groups/finance')).json()).toMatchObject({ rows: [{ payingGroupId: 'finance' }] });
  const fresh = await payingGroupAuthority(nats.store, 'acme', 'owner', 'finance', auth.binding);
  const actor = new BudgetActor(nats.store, 'acme');
  await actor.start(2000, 20000, 'personal-default');
  expect(await actor.configure({ scope: 'paying_group', scopeId: 'finance', ceilingCents: 1, setBy: 'owner' })).toEqual({ status: 'appended' });
  await expect(actor.reserve({ model: 'gpt-6-luna', payingGroupId: 'finance', priceTableId, computerId: 'computer', assistantId: 'assistant', requesterId: 'owner', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', contextDigest: 'a'.repeat(64) }, 2, fresh)).rejects.toThrow('Paying group spending cap reached');
  expect(actor.state.defaultPayingGroupId).toBe('personal-default');
  expect(actor.state.reservations).toHaveLength(0);
};
it('links a created group to the existing paying-group ceiling without changing the personal default', usesExistingPayingGroupCeiling);
const refusesUntrustedOrAlteredRequests = async () => {
  const cookie = `${config.cookieName}=${encodeSession(config, { sub: 'idp-owner', orgId: 'org-acme', roles: [], authTime: 1, exp: 2000000000 })}`;
  const input = { commandId: 'create-sales', groupId: 'sales', name: 'Sales' };
  const before = await nats.store.head();
  expect((await app.inject({ method: 'GET', url: '/api/groups' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/groups', payload: input, headers: { cookie, origin: 'https://foreign.test' } })).statusCode).toBe(403);
  expect((await request('POST', '/api/groups', { ...input, name: 'Different' })).statusCode).toBe(409);
  expect((await request('POST', '/api/groups', { ...input, action: 'remove' })).statusCode).toBe(400);
  expect((await request('POST', '/api/groups/sales', { action: 'add', groupId: 'finance', commandId: 'override', memberId: 'owner' })).statusCode).toBe(400);
  expect((await request('POST', '/api/groups', { ...input, name: 'a'.repeat(201) })).statusCode).toBe(400);
  expect((await request('POST', '/api/groups', { commandId: 'nul-name', groupId: 'nul-name', name: 'Sales\u0000' })).statusCode).toBe(400);
  expect(await nats.store.head()).toBe(before);
};
it('requires the verified session and Origin and refuses altered command bodies', refusesUntrustedOrAlteredRequests);
const replaysDistinctGroupGrants = async () => {
  const { grantStream } = await import('@opencrane/authz');
  await append('assistant-shared', 'assistant.created', { assistantId: 'shared', ownerId: 'finance', kind: 'team' });
  await append(grantStream('assistant', 'shared'), 'grant.given', { resourceType: 'assistant', resourceId: 'shared', granteeId: 'finance', granteeKind: 'team', grantedBy: 'owner' });
  await runner.run(groups);
  const before = (await request('GET', '/api/groups/finance')).json<unknown>();
  expect(before).toMatchObject({ rows: [{ access: { grants: [
    { resourceType: 'assistant', resourceId: 'shared', relation: 'acts_for' },
    { resourceType: 'assistant', resourceId: 'shared', relation: 'use' },
  ] } }] });
  await rebuildGroupProjection(pgDb(dbs.queue), nats.reader, createLogger('group-replay', { level: 'silent' }), { verify: true });
  expect((await request('GET', '/api/groups/finance')).json()).toEqual(before);
};
it('keeps assistant authority and a resource grant distinct through group replay', replaysDistinctGroupGrants);

function resolveMemberId(_silo: string, _issuer: string, subject: string) {
  const memberId = subject.replace('idp-', '');
  return Promise.resolve(memberId);
}

function appendIdentity(memberId: string, type: string, data: unknown, apply = false) {
  return append(`member-${memberId}`, type, data, apply);
}

function checkEmail(sub = 'idp-identity-owner', orgId = 'org-acme', origin = 'https://app.example.test',
  payload: unknown = { email: 'invitee@example.test' }) {
  const cookie = encodeSession(config, { sub, orgId, roles: ['admin'],
    authTime: 1790856000, exp: 2000000000 });
  return app.inject({ method: 'POST', url: '/api/invitations/identity',
    payload: JSON.stringify(payload), headers: {
      'content-type': 'application/json', origin, cookie: `${config.cookieName}=${cookie}`,
    } });
}
async function acceptsEmailWithoutClaimingIdentity() {
  const before = await nats.store.head();
  for (const email of ['invitee@example.test', 'unknown@example.test']) {
    const response = await checkEmail('idp-identity-owner', 'org-acme',
      'https://app.example.test', { email });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      status: 'confirmation_on_acceptance', email,
      message: 'The person is confirmed when they accept the invitation.',
    });
  }
  expect(await nats.store.head()).toBe(before);
}
it('accepts an email without claiming existence, verification or organisation membership',
  acceptsEmailWithoutClaimingIdentity);

async function rejectsUntrustedRequests() {
  await appendIdentity('member', 'member.joined', { memberId: 'member', email: 'member@example.test',
    displayName: 'Member', role: 'member' }, true);
  for (const args of [['idp-member'], ['pending'], ['idp-identity-owner', 'another-org'],
    ['idp-identity-owner', 'org-acme', 'https://foreign.test']] as const) {
    expect((await checkEmail(...args)).statusCode).toBe(403);
  }
  expect((await checkEmail('idp-identity-owner', 'org-acme', 'https://app.example.test',
    { email: 'invitee@example.test', memberId: 'client-choice' })).statusCode).toBe(400);
  for (const email of ['invalid', `${'a'.repeat(255)}@example.test`]) {
    const response = await checkEmail('idp-identity-owner', 'org-acme',
      'https://app.example.test', { email });
    expect(response.statusCode).toBe(400);
  }
  const oversized = await checkEmail('idp-identity-owner', 'org-acme',
    'https://app.example.test', { email: 'invitee@example.test', extra: 'a'.repeat(1024) });
  expect(oversized.statusCode).toBe(413);
  const anonymous = await app.inject({ method: 'POST', url: '/api/invitations/identity',
    payload: { email: 'invitee@example.test' } });
  expect(anonymous.statusCode).toBe(401);
}
it('refuses stale elevated cookies, absent membership, foreign organisation and Origin',
  rejectsUntrustedRequests);
function admissionForInvitee() {
  return deriveAdmission(nats.store, 'acme', config.issuerUrl, 'invitee',
    new Date(), performance.now() + 10_000);
}
async function keepsAdmissionsSeparate() {
  const firstResult = await admissionForInvitee();
  if (!('memberId' in firstResult)) throw new Error('Expected a new admission');
  const first = firstResult.memberId;
  const invited = { memberId: 'legacy', email: 'invitee@example.test', role: 'member',
    invitedBy: 'owner', invitationId: 'legacy-invite',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'invitee' },
    expiresAt: '2099-01-01T00:00:00Z' };
  for (const subjects of [['different-person', 'invitee'], ['invitee', 'different-person']]) {
    const memberId = subjects.join('-');
    for (const sub of subjects) {
      await appendIdentity(memberId, 'member.invited', { ...invited, memberId,
        invitedIdentity: { issuer: config.issuerUrl, sub } });
    }
    expect(await admissionForInvitee()).toEqual({ status: 'identity_mismatch' });
    await appendIdentity(memberId, 'member.removed', { memberId, removedBy: 'owner' });
  }
  await appendIdentity('legacy', 'member.invited', invited);
  expect(await admissionForInvitee()).toMatchObject({ memberId: 'legacy', membership: 'pending' });
  await appendIdentity('legacy', 'member.joined', { memberId: 'legacy', email: invited.email,
    displayName: 'Invitee', role: 'member' });
  expect(await admissionForInvitee()).toMatchObject({ memberId: 'legacy', membership: 'joined' });
  await appendIdentity('duplicate', 'member.invited', { ...invited, memberId: 'duplicate' });
  expect(await admissionForInvitee()).toEqual({ status: 'ambiguous' });
  await appendIdentity('duplicate', 'member.removed', { memberId: 'duplicate', removedBy: 'owner' });
  await appendIdentity('legacy', 'member.removed', { memberId: 'legacy', removedBy: 'owner' });
  expect(await admissionForInvitee()).toMatchObject({ memberId: first, memberSequence: 0 });
  await appendIdentity(first, 'member.invited', { ...invited, memberId: first });
  await appendIdentity(first, 'member.removed', { memberId: first, removedBy: 'owner' });
  const nextResult = await admissionForInvitee();
  if (!('memberId' in nextResult)) throw new Error('Expected the next admission');
  const next = nextResult.memberId;
  expect(next).not.toBe(first);
  expect(await admissionForInvitee()).toMatchObject({ memberId: next, memberSequence: 0 });
  await appendIdentity(next, 'member.invited', { ...invited, memberId: next,
    invitedIdentity: { issuer: config.issuerUrl, sub: 'different-person' } });
  expect(await admissionForInvitee()).toEqual({ status: 'identity_mismatch' });
}
it('uses older bound ids and skips removed admissions when deriving the next id',
  keepsAdmissionsSeparate);
async function refusesWrongSiloAndMissingServices() {
  const invitationEmail = { silo: 'foreign', store: nats.store, binding: auth.binding,
    feed: { memberId: resolveMemberId } };
  const wrongSilo = buildServer(config, { invitationEmail });
  const missingServices = buildServer(config);
  const cookie = encodeSession(config, { sub: 'idp-identity-owner', orgId: 'org-acme',
    roles: ['admin'], authTime: 1790856000, exp: 2000000000 });
  const input = { method: 'POST' as const, url: '/api/invitations/identity',
    payload: { email: 'invitee@example.test' }, headers: {
      origin: 'https://app.example.test', cookie: `${config.cookieName}=${cookie}`,
    } };
  const before = await nats.store.head();
  try {
    expect((await wrongSilo.inject(input)).statusCode).toBe(403);
    expect((await missingServices.inject(input)).statusCode).toBe(503);
    expect(await nats.store.head()).toBe(before);
  } finally {
    await wrongSilo.close();
    await missingServices.close();
  }
}
it('refuses a mismatched silo and reports missing services as unavailable',
  refusesWrongSiloAndMissingServices);

async function reportsBrokenAccessAsUnavailable() {
  function brokenMemberId(): Promise<string | undefined> {
    return Promise.reject(new Error('private-provider-error'));
  }
  const invitationEmail = { silo: 'acme', store: nats.store, binding: auth.binding,
    feed: { memberId: brokenMemberId } };
  const errorApp = buildServer(config, { invitationEmail });
  const cookie = encodeSession(config, { sub: 'idp-identity-owner', orgId: 'org-acme',
    roles: ['admin'], authTime: 1790856000, exp: 2000000000 });
  const input = { method: 'POST' as const, url: '/api/invitations/identity',
    payload: { email: 'invitee@example.test' }, headers: {
      origin: 'https://app.example.test', cookie: `${config.cookieName}=${cookie}`,
    } };
  const before = await nats.store.head();
  try {
    const response = await errorApp.inject(input);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(await nats.store.head()).toBe(before);
  } finally {
    await errorApp.close();
  }
}
it('reports an access-check error as unavailable without claims about the person',
  reportsBrokenAccessAsUnavailable);

async function timesOutSlowAccessWithoutIdentityClaims() {
  let release!: (memberId: string) => void;
  function captureRelease(resolve: (memberId: string) => void) {
    release = resolve;
  }
  const waiting = new Promise<string>(captureRelease);
  function slowMemberId() {
    return waiting;
  }
  const invitationEmail = { silo: 'acme', store: nats.store, binding: auth.binding,
    feed: { memberId: slowMemberId } };
  const slowApp = buildServer(config, { invitationEmail });
  const cookie = encodeSession(config, { sub: 'idp-identity-owner', orgId: 'org-acme',
    roles: ['admin'], authTime: 1790856000, exp: 2000000000 });
  const input = { method: 'POST' as const, url: '/api/invitations/identity',
    payload: { email: 'invitee@example.test' }, headers: {
      origin: 'https://app.example.test', cookie: `${config.cookieName}=${cookie}`,
    } };
  const before = await nats.store.head();
  try {
    const response = await slowApp.inject(input);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(await nats.store.head()).toBe(before);
  } finally {
    release('identity-owner');
    await slowApp.close();
  }
}
it('times out a slow access read without appending or returning identity claims',
  timesOutSlowAccessWithoutIdentityClaims);

async function deniesRemovedManager() {
  await appendIdentity('identity-owner', 'member.removed', { memberId: 'identity-owner', removedBy: 'admin' });
  const response = await checkEmail();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it('removal refuses the email check while the identity mapping and IAM still grant admin access',
  deniesRemovedManager);

async function refusesAdmissionLimits() {
  for (let number = 0; number < 20; number++) {
    const result = await deriveAdmission(nats.store, 'acme', config.issuerUrl, 'limited-invitee',
      new Date(), performance.now() + 10_000);
    if (!('memberId' in result)) throw new Error('Expected an unused admission');
    await appendIdentity(result.memberId, 'member.removed',
      { memberId: result.memberId, removedBy: 'owner' });
  }
  const before = await nats.store.head();
  const result = await deriveAdmission(nats.store, 'acme', config.issuerUrl, 'limited-invitee',
    new Date(), performance.now() + 10_000);
  expect(result).toEqual({ status: 'admission_limit' });
  expect(await nats.store.head()).toBe(before);
}
it('refuses a twenty-first admission without reusing a removed member stream', refusesAdmissionLimits);

async function refusesIncompleteAdmissionHistory() {
  const fixture = { ...event('bulk-member', 'member-bulk', 'member.removed'), silo: 'acme',
    data: { memberId: 'bulk', removedBy: 'owner' } };
  async function* bulkHistory() {
    for (let index = 1; index <= 10_001; index++) {
      const storedEvent = { event: fixture, sequence: index };
      yield await Promise.resolve(storedEvent);
    }
  }
  const spy = vi.spyOn(nats.store, 'readStream').mockImplementation(bulkHistory);
  try {
    const pending = admissionForInvitee();
    await expect(pending).rejects.toThrow('Identity history unavailable');
  } finally {
    spy.mockRestore();
  }
  await append('member-foreign-admission', 'member.removed',
    { memberId: 'foreign-admission', removedBy: 'owner' }, false, 'foreign');
  await expect(admissionForInvitee()).rejects.toThrow('Identity history unavailable');
}
it('refuses an incomplete member search and member events from another silo',
  refusesIncompleteAdmissionHistory);
