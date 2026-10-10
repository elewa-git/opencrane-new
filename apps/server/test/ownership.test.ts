import { parseEventByType } from '@opencrane/events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { currentMembership, seedOwnership, ownershipConfirmationHandler } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditTrail, connectMemberFeed, members, pgDb, ProjectionRunner,
  readEvents, rebuildMemberProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { refusalDigest } from '../src/members/refusals.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let count = 0;
const logger = createLogger('ownership-test', { level: 'silent' });

async function append(subject: string, type: string, data: unknown, silo = 'acme') {
  const record = {
    ...event(`ownership-fixture-${++count}`, subject, type), silo, data,
    correlation: {}, principal: { kind: 'human' as const, id: 'idp-owner' },
  };
  const expectedSequence = await nats.store.head(subject);
  expect((await nats.store.append({ event: record, expectedSequence })).status).toBe('appended');
  return record;
}
async function project() {
  const handler = ownershipConfirmationHandler(nats.store);
  for await (const row of nats.reader.readStream('ownership-acme')) {
    if (row.event.type === 'ownership.transferred') {
      await handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  const head = await nats.reader.head();
  for await (const row of readEvents(nats.reader, 1, head)) {
    if (row.event.silo === 'acme' && auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  await runner.run(members);
}
function resolveMemberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject.replace('idp-', ''));
}
function request(method: 'GET' | 'POST', payload?: unknown, sub = 'idp-owner',
  url = '/api/ownership', orgId = 'org-acme') {
  const email = `${sub.slice(4)}@example.test`;
  const authTime = Math.floor(Date.now() / 1000);
  const session = { sub, orgId, roles: [], authTime, exp: 2000000000,
    email, emailVerified: true };
  const headers = {
    origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}`,
  };
  return app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(members);
  await runner.initialise(auditTrail);
  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member'], ['admin', 'admin']]) {
    const data = { memberId, email: `${memberId}@example.test`, displayName: memberId, role };
    const joined = await append(`member-${memberId}`, 'member.joined', data);
    await auth.handler.handle(joined, db);
  }
  await append('conversation-private-owner-chat', 'conversation.created', {
    conversationId: 'private-owner-chat', assistantId: 'private-assistant', createdBy: 'owner',
    mode: 'agent_session',
  });
  await project();
  const options = {
    silo: 'acme', store: nats.store, db, binding, feed: { memberId: resolveMemberId },
  };
  app = buildServer(config, { ownership: options, audit: options });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

async function projectsPostSeedInvitations() {
  await seedOwnership(nats.store, 'acme');
  await project();
  await append('member-owner', 'member.invited', {
    memberId: 'owner', email: 'changed@example.test', role: 'member', invitedBy: 'admin',
    invitationId: 'reinvite-seeded-owner', expiresAt: '2026-11-01T00:00:00Z',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'another-identity' },
  });
  await append('member-pending-owner', 'member.invited', {
    memberId: 'pending-owner', email: 'pending@example.test', role: 'owner', invitedBy: 'owner',
    invitationId: 'invite-pending-owner', expiresAt: '2026-11-01T00:00:00Z',
  });
  await runner.run(members);
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  try {
    const changes = await feed.read('acme', 0);
    function concernsOwner(change: (typeof changes)[number]) {
      return change.member.memberId === 'owner';
    }
    const ownerChanges = changes.filter(concernsOwner);
    expect(ownerChanges.at(-1)?.member).toMatchObject({ role: 'owner', status: 'joined' });
    expect(await feed.memberId('acme', config.issuerUrl, 'another-identity')).toBeUndefined();
    expect((await request('GET')).statusCode).toBe(200);
    await runner.rebuild(members);
    expect((await request('GET')).statusCode).toBe(200);
  } finally {
    await feed.close();
  }
}
it('post-seed invitations let the members projection continue and preserve active owners',
  projectsPostSeedInvitations);

async function refusesPlainMemberTransfer() {
  const before = await nats.store.head();
  const input = { action: 'transfer', commandId: 'member-appoint', successorId: 'admin',
    expectedSequence: await nats.store.head('ownership-acme') };
  expect((await request('POST', input, 'idp-bob')).statusCode).toBe(403);
  expect(await nats.store.head()).toBe(before);
}
it('a plain Member cannot transfer ownership', refusesPlainMemberTransfer);

async function conflictsOnAuthorityChange() {
  const input = { action: 'transfer', commandId: 'changed-authority', successorId: 'bob',
    expectedSequence: await nats.store.head('ownership-acme') };
  const original = nats.store.head.bind(nats.store);
  let changed = false;
  async function changeAuthority(subject?: string, deadline?: number) {
    if (subject === 'member-owner' && !changed) {
      changed = true;
      await append('member-owner', 'member.invited', {
        memberId: 'owner', email: 'owner@example.test', role: 'admin', invitedBy: 'admin',
        invitationId: 'authority-race', expiresAt: '2026-11-01T00:00:00Z',
      });
    }
    return original(subject, deadline);
  }
  const spy = vi.spyOn(nats.store, 'head').mockImplementation(changeAuthority);
  try {
    const response = await request('POST', input);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: 'concurrent_change' });
  } finally {
    spy.mockRestore();
  }
  expect(await nats.store.head('ownership-acme')).toBe(input.expectedSequence);
}
it('a change to watched authority returns an ownership conflict before append',
  conflictsOnAuthorityChange);

async function readsAuditDuringChatActivity() {
  const original = nats.store.readStream.bind(nats.store);
  let activityAppended = false;
  async function* appendChatActivityBeforeMembershipRead(
    ...streamArguments: Parameters<typeof nats.store.readStream>
  ) {
    const [subject, fromSequence, deadline] = streamArguments;
    if (subject === 'member-owner' && !activityAppended) {
      activityAppended = true;
      await append('conversation-private-owner-chat', 'message.posted', {
        conversationId: 'private-owner-chat',
        authorId: 'owner',
        authorKind: 'human',
        ciphertext: Buffer.from('ordinary chat activity').toString('base64'),
        keyId: 'key:owner-test',
        contentType: 'text',
      });
    }
    yield* original(subject, fromSequence, deadline);
  }
  const spy = vi.spyOn(nats.store, 'readStream')
    .mockImplementation(appendChatActivityBeforeMembershipRead);
  try {
    const response = await request('GET', undefined, 'idp-owner',
      '/api/conversations/private-owner-chat/history');
    expect(response.statusCode).toBe(200);
    expect(activityAppended).toBe(true);
  } finally {
    spy.mockRestore();
  }
}
it('does not refuse audit reads when ordinary chat activity arrives during the access check',
  readsAuditDuringChatActivity);

async function readsReceiptWithNewBound() {
  const input = { action: 'transfer', commandId: 'slow-append', successorId: 'admin',
    expectedSequence: await nats.store.head('ownership-acme') };
  const original = nats.store.append.bind(nats.store);
  const realNow = performance.now.bind(performance);
  let elapsed = 0;
  function now() {
    return realNow() + elapsed;
  }
  async function slowAppend(command: Parameters<typeof original>[0]) {
    const result = await original(command);
    elapsed = 2100;
    return result;
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(slowAppend);
  try {
    expect((await request('POST', input)).statusCode).toBe(200);
  } finally {
    spy.mockRestore();
    clock.mockRestore();
  }
  await project();
  const stepDown = { action: 'step_down', commandId: 'restore-slow-append-fixture',
    expectedSequence: await nats.store.head('ownership-acme') };
  expect((await request('POST', stepDown, 'idp-admin')).statusCode).toBe(200);
  await project();
}
it('a successful append has a separate bound for reading its receipt', readsReceiptWithNewBound);

async function appointsSuccessor() {
  await seedOwnership(nats.store, 'acme');
  await seedOwnership(nats.store, 'acme');
  await project();
  const spy = vi.spyOn(nats.store, 'append');
  const input = { action: 'transfer', commandId: 'appoint-bob', successorId: 'bob',
    expectedSequence: await nats.store.head('ownership-acme') };
  try {
    const response = await request('POST', input);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'appended', commandId: 'appoint-bob' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].expectedSequence).toBe(input.expectedSequence);
    expect((await request('POST', input)).json()).toEqual(response.json());
    expect(spy).toHaveBeenCalledTimes(1);
    await project();
    expect((await auth.check('owner', 'owner')).allowed).toBe(true);
    expect((await auth.check('bob', 'owner')).allowed).toBe(true);
    expect((await request('GET')).json()).toMatchObject({ owners: [
      { memberId: 'bob', role: 'owner' }, { memberId: 'owner', role: 'owner' },
    ] });
  } finally {
    spy.mockRestore();
  }
}
it('seeds once and appoints an active successor with one event while retaining the previous owner',
  appointsSuccessor);

async function successorCanManageGroups() {
  await app.close();
  const options = { silo: 'acme', store: nats.store, db: pgDb(dbs.queue),
    binding: auth.binding, feed: { memberId: resolveMemberId } };
  app = buildServer(config, { ownership: options, groups: options,
    membership: { silo: options.silo, store: options.store } });
  const body = { commandId: 'new-owner-group', groupId: 'sales', name: 'Sales' };
  const response = await request('POST', body, 'idp-bob', '/api/groups');
  expect(response.statusCode).toBe(200);
}
it('the successor can use existing Owner/Admin commands with event-derived authority',
  successorCanManageGroups);

async function refusesUnqualifiedOwnership() {
  const sequence = await nats.store.head('ownership-acme');
  const before = await nats.store.head();
  const input = { action: 'transfer', commandId: 'admin-appoint', successorId: 'admin',
    expectedSequence: sequence };
  expect((await request('POST', input, 'idp-admin')).statusCode).toBe(403);
  expect((await request('POST', input, 'idp-missing')).statusCode).toBe(403);
  expect((await request('POST', input, 'idp-owner', '/api/ownership', 'foreign')).statusCode).toBe(403);
  expect((await request('POST', { ...input, successorId: 'unknown' })).statusCode).toBe(403);
  expect((await request('POST', { ...input, role: 'owner' })).statusCode).toBe(400);
  expect((await request('POST', { ...input, expectedSequence: 0 })).statusCode).toBe(409);
  const absent = await request('GET', undefined, 'idp-owner', '/api/ownership/changes/missing');
  expect(absent.statusCode).toBe(404);
  expect(await nats.store.head()).toBe(before);
}
it('refuses non-owners, foreign sessions, missing successors and stale or unsupported input',
  refusesUnqualifiedOwnership);

async function serialisesStepDown() {
  const expectedSequence = await nats.store.head('ownership-acme');
  const original = nats.store.append.bind(nats.store);
  let arrivals = 0;
  let release!: () => void;
  function captureRelease(resolve: () => void) {
    release = resolve;
  }
  const barrier = new Promise<void>(captureRelease);
  async function appendTogether(input: Parameters<typeof original>[0]) {
    const record = parseEventByType(input.event);
    if (!record.success) {
      throw new Error('Invalid fixture event');
    }
    if (record.event.type === 'ownership.stepped_down') {
      if (++arrivals === 2) {
        release();
      }
      await barrier;
    }
    return original(input);
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(appendTogether);
  try {
    const owner = request('POST', { action: 'step_down', commandId: 'down-owner', expectedSequence });
    const bob = request('POST', { action: 'step_down', commandId: 'down-bob', expectedSequence }, 'idp-bob');
    const responses = await Promise.all([owner, bob]);
    function statusCode(response: (typeof responses)[number]) {
      return response.statusCode;
    }
    const codes = responses.map(statusCode);
    codes.sort();
    expect(codes).toEqual([200, 409]);
  } finally {
    spy.mockRestore();
  }
  await project();
  const response = await request('GET');
  const result = response.json<{ owners: { memberId: string }[] }>();
  expect(result.owners).toHaveLength(1);
  const remainingId = result.owners[0]!.memberId;
  const stepDown = { action: 'step_down', commandId: 'last-down',
    expectedSequence: await nats.store.head('ownership-acme') };
  const lastOwner = await request('POST', stepDown, `idp-${remainingId}`);
  expect(lastOwner.statusCode).toBe(409);
  expect(lastOwner.json()).toMatchObject({ reason: 'last_owner',
    rule: 'At least one owner must remain', action: 'appoint_another_owner' });
  const steppedDownId = remainingId === 'owner' ? 'bob' : 'owner';
  expect((await auth.check(steppedDownId, 'owner')).allowed).toBe(false);
  expect((await auth.check(steppedDownId, 'admin')).allowed).toBe(true);
  const retry = { action: 'step_down', commandId: `down-${steppedDownId}`, expectedSequence };
  expect((await request('POST', retry, `idp-${steppedDownId}`)).statusCode).toBe(200);
}
it('racing owner demotions leave one owner and a separate step-down keeps Admin rights',
  serialisesStepDown);

async function reconcilesLostAcknowledgement() {
  const state = (await request('GET')).json<{ owners: { memberId: string }[]; sequence: number }>();
  const actorId = state.owners[0]!.memberId;
  const input = { action: 'transfer', commandId: 'lost-ack', successorId: 'admin',
    expectedSequence: state.sequence };
  const original = nats.store.append.bind(nats.store);
  async function loseAcknowledgement(command: Parameters<typeof original>[0]) {
    await original(command);
    return { status: 'unavailable' as const, cause: new Error('Lost acknowledgement') };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(loseAcknowledgement);
  expect((await request('POST', input, `idp-${actorId}`)).statusCode).toBe(503);
  spy.mockRestore();
  const url = '/api/ownership/changes/lost-ack';
  const pending = await request('GET', undefined, `idp-${actorId}`, url);
  expect(pending.statusCode).toBe(200);
  expect(pending.json()).toMatchObject({ status: 'appended', commandId: 'lost-ack',
    actorId, data: { memberId: 'admin', transferredBy: actorId },
    projection: { content: 'applying', iam: 'applying' } });
  const retrySpy = vi.spyOn(nats.store, 'append');
  try {
    expect((await request('POST', input, `idp-${actorId}`)).statusCode).toBe(200);
    expect(retrySpy).not.toHaveBeenCalled();
    const altered = { ...input, successorId: 'bob' };
    expect((await request('POST', altered, `idp-${actorId}`)).statusCode).toBe(409);
    await project();
    const confirmed = await request('GET', undefined, `idp-${actorId}`, url);
    expect(confirmed.json()).toMatchObject({ projection: { content: 'current', iam: 'current' } });
    const receipt = confirmed.json<{ recordedAt: string; changeId: string }>();
    expect(receipt.recordedAt).toEqual(expect.any(String));
    expect(receipt.changeId).toEqual(expect.any(String));
    expect((await auth.conversation('admin', 'private-owner-chat', 'read')).allowed).toBe(false);
    await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, logger, { verify: true });
    const rebuilt = await rebuildMembers(fga.apiUrl, 'acme', nats.reader, { verifyAgainst: auth.binding });
    expect((await rebuilt.check('admin', 'owner')).allowed).toBe(true);
    expect((await rebuilt.conversation('admin', 'private-owner-chat', 'read')).allowed).toBe(false);
  } finally {
    retrySpy.mockRestore();
  }
}
it('a lost acknowledgement reconciles the original command, waits for both projections and replays',
  reconcilesLostAcknowledgement);

async function reconcilesLostStepDown() {
  const input = { action: 'step_down', commandId: 'lost-step-down',
    expectedSequence: await nats.store.head('ownership-acme') };
  const original = nats.store.append.bind(nats.store);
  async function loseAcknowledgement(command: Parameters<typeof original>[0]) {
    await original(command);
    return { status: 'unavailable' as const, cause: new Error('Lost acknowledgement') };
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementationOnce(loseAcknowledgement);
  try {
    expect((await request('POST', input, 'idp-admin')).statusCode).toBe(503);
  } finally {
    spy.mockRestore();
  }
  const url = '/api/ownership/changes/lost-step-down';
  const response = await request('GET', undefined, 'idp-admin', url);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'appended', actorId: 'admin',
    projection: { content: 'applying', iam: 'applying' } });
  const before = await nats.store.head();
  expect((await request('POST', input, 'idp-admin')).statusCode).toBe(503);
  expect(await nats.store.head()).toBe(before);
  await project();
  expect((await request('POST', input, 'idp-admin')).statusCode).toBe(200);
}
it('Check status reconciles an own lost step-down response before its IAM receipt',
  reconcilesLostStepDown);

async function assertRefusalPreservesAuthority(memberId: string, commandId: string,
  before: number, memberSequence: number, ownershipSequence: number, role: string) {
  const rows = [];
  const latest = await nats.reader.head();
  for await (const row of readEvents(nats.reader, before + 1, latest)) {
    rows.push(row);
  }
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({
    subject: `memberaudit-${memberId}`, type: 'member.command_refused',
    data: { memberId, originalCommandDigest: refusalDigest(commandId), operation: 'join' },
  });
  expect(await nats.store.head(`member-${memberId}`)).toBe(memberSequence);
  expect(await nats.store.head('ownership-acme')).toBe(ownershipSequence);
  const membership = await currentMembership(nats.store, 'acme', memberId);
  expect(membership.role).toBe(role);
  expect(auth.handler.eventTypes).not.toContain('member.command_refused');
  await runner.run(members);
  const projected = await dbs.queue.query<{ role: string; status: string }>(
    'SELECT role, status FROM members WHERE silo = $1 AND member_id = $2', ['acme', memberId]);
  if (role) {
    expect(projected.rows[0]?.role).toBe(role);
  } else {
    expect(projected.rows[0]?.status).toBe('invited');
  }
}

async function refusesOwnerInvitation() {
  await append('member-invitee', 'member.invited', {
    memberId: 'invitee', email: 'invitee@example.test', role: 'owner', invitedBy: 'owner',
    invitationId: 'invite-owner', expiresAt: '2026-11-01T00:00:00Z', invitedIdentity: { issuer: config.issuerUrl, sub: 'idp-invitee' },
  });
  const before = await nats.store.head();
  const memberSequence = await nats.store.head('member-invitee');
  const ownershipSequence = await nats.store.head('ownership-acme');
  const input = { memberId: 'invitee', invitationId: 'invite-owner',
    commandId: 'join-owner', displayName: 'Invitee' };
  const response = await request('POST', input, 'idp-invitee', '/members/join');
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'ownership_stream_required' });
  await assertRefusalPreservesAuthority('invitee', input.commandId, before,
    memberSequence, ownershipSequence, '');
  expect(await nats.store.head()).toBe(before + 1);
}
it('invitation acceptance cannot appoint an owner outside the ownership stream', refusesOwnerInvitation);

async function refusesInactiveAndForeignSuccessors() {
  const state = (await request('GET')).json<{ owners: { memberId: string }[]; sequence: number }>();
  const actorId = state.owners[0]!.memberId;
  await append('member-inactive', 'member.joined', {
    memberId: 'inactive', email: 'inactive@example.test', displayName: 'Inactive', role: 'member',
  });
  await append('member-inactive', 'member.removed', { memberId: 'inactive', removedBy: actorId });
  await append('member-foreign', 'member.joined', {
    memberId: 'foreign', email: 'foreign@example.test', displayName: 'Foreign', role: 'member',
  }, 'other');
  const before = await nats.store.head();
  const input = { action: 'transfer', commandId: 'bad-successor', successorId: 'inactive',
    expectedSequence: state.sequence };
  expect((await request('POST', input, `idp-${actorId}`)).statusCode).toBe(403);
  expect((await request('POST', { ...input, successorId: 'foreign' }, `idp-${actorId}`)).statusCode)
    .toBe(503);
  expect(await nats.store.head()).toBe(before);
}
it('refuses inactive and same-id foreign successor histories without writing',
  refusesInactiveAndForeignSuccessors);

async function deniesUnappliedOwnerChange() {
  const state = (await request('GET')).json<{ owners: { memberId: string }[]; sequence: number }>();
  const actorId = state.owners[0]!.memberId;
  const successorId = actorId === 'owner' ? 'bob' : 'owner';
  const input = { action: 'transfer', commandId: 'pending-owner', successorId,
    expectedSequence: state.sequence };
  expect((await request('POST', input, `idp-${actorId}`)).statusCode).toBe(200);
  const before = await nats.store.head();
  const next = { action: 'step_down', commandId: 'pending-down',
    expectedSequence: await nats.store.head('ownership-acme') };
  expect((await request('POST', next, `idp-${successorId}`)).statusCode).toBe(403);
  expect(await nats.store.head()).toBe(before);
  const handler = ownershipConfirmationHandler(nats.store);
  for await (const row of nats.store.readStream('ownership-acme')) {
    if (row.event.type === 'ownership.transferred') {
      await handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  expect((await request('POST', next, `idp-${successorId}`)).statusCode).toBe(503);
  await project();
  expect((await request('POST', next, `idp-${successorId}`)).statusCode).toBe(200);
  await project();
}
it('a new owner cannot exercise ownership authority until IAM has the event receipt',
  deniesUnappliedOwnerChange);

async function refusesOwnerReinvitation() {
  const state = (await request('GET')).json<{ owners: { memberId: string }[] }>();
  const actorId = state.owners[0]!.memberId;
  await append(`member-${actorId}`, 'member.invited', {
    memberId: actorId, email: `${actorId}@example.test`, role: 'member', invitedBy: 'admin',
    invitationId: 'reinvite-owner', expiresAt: '2026-11-01T00:00:00Z',
    invitedIdentity: { issuer: config.issuerUrl, sub: `idp-${actorId}` },
  });
  const input = { memberId: actorId, invitationId: 'reinvite-owner',
    commandId: 'rejoin-owner', displayName: actorId };
  const before = await nats.store.head();
  const memberSequence = await nats.store.head(`member-${actorId}`);
  const ownershipSequence = await nats.store.head('ownership-acme');
  expect((await request('POST', input, `idp-${actorId}`, '/members/join')).statusCode).toBe(409);
  await assertRefusalPreservesAuthority(actorId, input.commandId, before,
    memberSequence, ownershipSequence, 'owner');
  expect(await nats.store.head()).toBe(before + 1);
}
it('reinviting an active owner cannot demote them through invitation acceptance',
  refusesOwnerReinvitation);
