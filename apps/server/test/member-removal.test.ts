import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { currentMembership, currentOwnershipMembership, history,
  ownershipConfirmationHandler, seedOwnership } from '@opencrane/models';
import { computers, conversations, members, pgDb, ProjectionRunner,
  readEvents } from '@opencrane/projections';
import { memberDepartureSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const eventTypeSchema = z.object({ type: z.string() });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let counter = 0;
let keyDirectory: string;
async function append(subject: string, type: string, data: unknown) {
  const record = { ...event(`removal-${++counter}`, subject, type), data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  return record;
}
async function project() {
  for await (const row of readEvents(nats.reader, 1, await nats.reader.head())) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  for (const projection of [members, conversations, computers]) await runner.run(projection);
}
function request(memberId: string, section: string, payload?: unknown, actor = 'owner') {
  const session = { sub: actor, orgId: 'org-test', roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { 'content-type': 'application/json',
    origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const method = payload === undefined ? 'GET' : 'POST';
  const options = { method, url: `/api/members/${memberId}/${section}`, headers } as const;
  if (payload === undefined) return app.inject(options);
  const withBody = { ...options, payload: JSON.stringify(payload) };
  return app.inject(withBody);
}
async function review(memberId: string, commandId = `remove-${memberId}`) {
  const response = await request(memberId, 'departure');
  expect(response.statusCode, response.body).toBe(200);
  const body = memberDepartureSchema.parse(response.json());
  return { commandId, expectedSequence: body.memberSequence, reviewRevision: body.reviewRevision };
}
async function join(memberId: string) {
  const joined = await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId,
  });
  await auth.handler.handle(joined, pgDb(dbs.queue));
  await project();
}
async function initialise() {
  keyDirectory = await mkdtemp(`${tmpdir()}/removal-keys-`);
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding, nats.reader);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('removal-test'));
  for (const projection of [members, conversations, computers]) await runner.initialise(projection);
  await append('member-owner', 'member.joined', {
    memberId: 'owner', role: 'owner', email: 'owner@example.test', displayName: 'Owner',
  });
  await seedOwnership(nats.store, 'test');
  await project();
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const options = { silo: 'test', store: nats.store, db, binding, feed: { memberId } };
  const serverOptions = { memberReads: options, ownership: options };
  app = buildServer(config, serverOptions);
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
  if (keyDirectory) await rm(keyDirectory, { recursive: true, force: true });
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);

async function reconcilesRemoval() {
  await join('lost-reply');
  const input = await review('lost-reply');
  const response = await request('lost-reply', 'remove', input);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'recorded', access: 'revoked',
    commandId: input.commandId, reviewRevision: input.reviewRevision });
  const before = await nats.store.head();
  expect((await request('lost-reply', 'remove', input)).json()).toEqual(response.json());
  const changed = { ...input, reviewRevision: '0'.repeat(64) };
  expect((await request('lost-reply', 'remove', changed)).json())
    .toMatchObject({ status: 'refused', reason: 'command_id_reused' });
  const status = await request('lost-reply', `changes/${input.commandId}`);
  expect(status.json()).toMatchObject({ ...response.json<Record<string, unknown>>(),
    projection: { content: 'applying', iam: 'applying' } });
  expect(await nats.store.head()).toBe(before);
  expect((await request('owner', 'departure', undefined, 'lost-reply')).statusCode).toBe(403);
  await project();
  const projected = await request('lost-reply', `changes/${input.commandId}`);
  expect(projected.json()).toMatchObject({ access: 'revoked',
    projection: { content: 'current', iam: 'current' } });
  await runner.rebuild(members);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  expect((await rebuilt.check('lost-reply', 'member')).allowed).toBe(false);
  expect((await request('lost-reply', 'remove', input)).json()).toEqual(response.json());
}
it('recovers the original removal receipt and replays revoked access', reconcilesRemoval);

async function refusesUnsafeRemoval() {
  await join('reviewed');
  const input = await review('reviewed');
  expect((await request('reviewed', 'remove', input, 'reviewed')).statusCode).toBe(403);
  const ownerInput = await review('owner');
  const lastOwner = await request('owner', 'remove', ownerInput);
  expect(lastOwner.statusCode).toBe(409);
  expect(lastOwner.json()).toMatchObject({ reason: 'ownership_stream_required' });
  await append('team-changed', 'team.created', {
    teamId: 'changed', name: 'Changed', createdBy: 'owner',
  });
  const incomplete = await request('reviewed', 'remove', input);
  expect(incomplete.statusCode).toBe(409);
  expect(incomplete.json()).toMatchObject({ reason: 'incomplete_review' });
  await project();
  const stale = await request('reviewed', 'remove', input);
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ reason: 'stale_review' });
  const refreshed = await review('reviewed');
  expect((await request('reviewed', 'remove', refreshed)).statusCode).toBe(200);
}
it('refuses non-admins, the last owner, incomplete inventory and a stale review', refusesUnsafeRemoval);

async function losesAppendReply() {
  await join('lost-transport');
  const input = await review('lost-transport');
  const save = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof save>[0]) {
    const result = await save(command);
    if (eventTypeSchema.parse(command.event).type === 'member.removed') throw new Error('Reply lost');
    return result;
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(loseReply);
  expect((await request('lost-transport', 'remove', input)).statusCode).toBe(503);
  appendSpy.mockRestore();
  const status = await request('lost-transport', `changes/${input.commandId}`);
  expect(status.json()).toMatchObject({ status: 'recorded', access: 'revoked' });
  const retry = await request('lost-transport', 'remove', input);
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toMatchObject({ changeId: status.json<{ changeId: string }>().changeId });
  const changed = { ...input, expectedSequence: 0 };
  expect((await request('lost-transport', 'remove', changed)).statusCode).toBe(409);
}
it('checks the original command after a durable append loses its reply', losesAppendReply);

async function racesConfirmation(confirmationFirst: boolean) {
  const memberId = confirmationFirst ? 'confirmed-first' : 'removed-first';
  await join(memberId);
  const appointment = await append('ownership-test', 'ownership.transferred', {
    memberId, transferredBy: 'owner', awaitingConfirmation: true,
  });
  await project();
  const input = await review(memberId);
  const confirmation = ownershipConfirmationHandler(nats.store);
  const save = nats.store.append.bind(nats.store);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function pauseAppend(command: Parameters<typeof save>[0]) {
    if (eventTypeSchema.parse(command.event).type === 'member.ownership_confirmed') {
      reached.resolve();
      await release.promise;
    }
    return save(command);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(pauseAppend);
  const confirming = confirmation.handle(appointment, pgDb(dbs.queue));
  const outcome = confirming.then(confirmed, refused);
  function confirmed() { return 'confirmed'; }
  function refused() { return 'refused'; }
  try {
    await reached.promise;
    if (confirmationFirst) {
      release.resolve();
      expect(await outcome).toBe('confirmed');
    }
    const removal = await request(memberId, 'remove', input);
    expect(removal.statusCode).toBe(confirmationFirst ? 409 : 200);
    release.resolve();
    expect(await outcome).toBe(confirmationFirst ? 'confirmed' : 'refused');
    appendSpy.mockRestore();
    await confirmation.handle(appointment, pgDb(dbs.queue));
    await project();
    await runner.rebuild(members);
    const owners = await currentOwnershipMembership(nats.store, 'test', 'owner');
    expect(owners.owners.has('owner')).toBe(true);
    expect(owners.owners.has(memberId)).toBe(confirmationFirst);
    const membership = await currentMembership(nats.store, 'test', memberId);
    expect(membership.role).toBe(confirmationFirst ? 'owner' : '');
    const rows = await history(nats.reader, `member-${memberId}`, 'test');
    expect(rows.at(-1)?.event.type)
      .toBe(confirmationFirst ? 'member.ownership_confirmed' : 'member.removed');
  } finally {
    release.resolve();
    await outcome;
    appendSpy.mockRestore();
  }
}
it.each([false, true])('keeps an active owner when confirmation saves first: %s', racesConfirmation);

async function changesInventoryBeforeAppend() {
  await join('changed-at-append');
  const input = await review('changed-at-append');
  const save = nats.store.append.bind(nats.store);
  const readHead = nats.store.head.bind(nats.store);
  let changed = false;
  async function changeInventory(subject?: string, deadline?: number) {
    const position = await readHead(subject, deadline);
    const checkingAccess = deadline !== undefined && deadline - performance.now() <= 2000;
    if (!changed && subject === 'member-changed-at-append' && checkingAccess) {
      changed = true;
      const record = { ...event('late-team', 'team-late', 'team.created'),
        data: { teamId: 'late', name: 'Late group', createdBy: 'owner' } };
      const command = { event: record, expectedSequence: 0 };
      expect((await save(command)).status).toBe('appended');
    }
    return position;
  }
  const headSpy = vi.spyOn(nats.store, 'head');
  headSpy.mockImplementation(changeInventory);
  const response = await request('changed-at-append', 'remove', input);
  expect(changed).toBe(true);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'stale_review' });
  expect((await currentMembership(nats.reader, 'test', 'changed-at-append')).role).toBe('member');
  const rows = await history(nats.reader, 'member-changed-at-append', 'test');
  expect(rows).toHaveLength(1);
  expect(rows.at(-1)?.event.type).toBe('member.joined');
}
it('refuses inventory changes during the final access check and before append',
  changesInventoryBeforeAppend);

async function removesDuringOtherMembersPosts() {
  const memberId = 'busy-removal';
  await join(memberId);
  await join('posting-member');
  const input = await review(memberId);
  const keys = conversationKeys(keyDirectory);
  keys.provision('test', 'busy-chat');
  const save = nats.store.append.bind(nats.store);
  const readHead = nats.store.head.bind(nats.store);
  let posts = 0;
  async function postMessage() {
    const encrypted = keys.encrypt('test', 'busy-chat', 'Another member keeps posting');
    const data = { conversationId: 'busy-chat', authorId: 'posting-member',
      authorKind: 'human', contentType: 'text', ...encrypted };
    const record = { ...event(`busy-post-${++posts}`, 'conversation-busy-chat',
      'message.posted'), principal: { kind: 'human' as const, id: 'posting-member' }, data };
    const command = { event: record, expectedSequence: await readHead(record.subject) };
    expect((await save(command)).status).toBe('appended');
  }
  async function postDuringChecks(subject?: string, deadline?: number) {
    const position = await readHead(subject, deadline);
    if (subject === 'team-*' || subject === `member-${memberId}`) await postMessage();
    return position;
  }
  async function postBeforeAppend(command: Parameters<typeof save>[0]) {
    if (eventTypeSchema.parse(command.event).type === 'member.removed') await postMessage();
    return save(command);
  }
  await postMessage();
  await project();
  const headSpy = vi.spyOn(nats.store, 'head');
  headSpy.mockImplementation(postDuringChecks);
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(postBeforeAppend);
  const response = await request(memberId, 'remove', input);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ access: 'revoked', reviewRevision: input.reviewRevision });
  expect(posts).toBeGreaterThan(2);
  const rows = await history(nats.reader, `member-${memberId}`, 'test');
  expect(rows.at(-1)?.event.type).toBe('member.removed');
  expect((await currentMembership(nats.reader, 'test', memberId)).role).toBe('');
  const messages = await history(nats.reader, 'conversation-busy-chat', 'test');
  expect(messages).toHaveLength(posts);
}
it('removes a member while another member keeps posting during the checks and append',
  removesDuringOtherMembersPosts);

async function refusesTargetChangeBeforeAppend() {
  const memberId = 'target-changed-at-append';
  await join(memberId);
  const input = await review(memberId);
  const save = nats.store.append.bind(nats.store);
  async function changeTarget(command: Parameters<typeof save>[0]) {
    if (eventTypeSchema.parse(command.event).type === 'member.removed') {
      const data = { memberId, previousRole: 'member', newRole: 'admin', changedBy: 'owner' };
      const record = { ...event('late-target-role', `member-${memberId}`,
        'member.role_changed'), data };
      const change = { event: record, expectedSequence: input.expectedSequence };
      expect((await save(change)).status).toBe('appended');
    }
    return save(command);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementation(changeTarget);
  const response = await request(memberId, 'remove', input);
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ reason: 'concurrent_change' });
  const rows = await history(nats.reader, `member-${memberId}`, 'test');
  expect(rows).toHaveLength(2);
  expect(rows.at(-1)?.event.type).toBe('member.role_changed');
  expect((await currentMembership(nats.reader, 'test', memberId)).role).toBe('admin');
}
it('refuses removal when the target stream changes after the final check',
  refusesTargetChangeBeforeAppend);
