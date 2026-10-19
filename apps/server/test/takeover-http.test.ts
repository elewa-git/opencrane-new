import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { encodeSession } from '@opencrane/auth';
import type { AppendCommand } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { buildServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';

let fixture: Awaited<ReturnType<typeof viewFixture>>;
let app: ReturnType<typeof buildServer>;
let body: { commandId: string; requesterEventId: string; generation: number };
let desktopCalls = 0;
const cookies = new Map<string, string>();
function noDesktop(): Promise<never> {
  desktopCalls++;
  return Promise.reject(new Error('No desktop expected'));
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await fixture?.close();
}
afterEach(cleanup);
async function setup(requestsEnabled = true) {
  fixture = await viewFixture(noDesktop);
  desktopCalls = 0;
  cookies.clear();
  const chat = { ...fixture, store: fixture.nats.store, silo: 'test' };
  const options = { chat, takeoverRequestsEnabled: requestsEnabled };
  app = buildServer(fixture.config, options);
  const message = await fixture.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  }, true);
  body = { commandId: 'control-one', requesterEventId: message.id, generation: 1 };
}
function headers(member = 'alice', conversation = 'chat', orgId = 'org-test') {
  const config = fixture.config;
  const session = { sub: member, orgId, roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 300 };
  const key = JSON.stringify([member, orgId]);
  let cookie = cookies.get(key);
  if (!cookie) {
    cookie = `${config.cookieName}=${encodeSession(config, session)}`;
    cookies.set(key, cookie);
  }
  const hmac = createHmac('sha256', config.cookieSecret);
  hmac.update(JSON.stringify(['takeover', cookie, conversation]));
  return { cookie, origin: new URL(config.redirectUri).origin, 'x-csrf-token': hmac.digest('hex') };
}
function post(payload: unknown = body, member = 'alice', conversation = 'chat') {
  const request = { method: 'POST' as const, url: `/api/conversations/${conversation}/takeover`,
    headers: headers(member, conversation), payload: JSON.stringify(payload) };
  return app.inject({ ...request, headers: { ...request.headers, 'content-type': 'application/json' } });
}
async function disabledRequests() {
  await setup(false);
  const before = await fixture.nats.store.head();
  const response = await post();
  expect(response.statusCode).toBe(503);
  expect(await fixture.nats.store.head()).toBe(before);
  expect(desktopCalls).toBe(0);
}
it('keeps HTTP requests switched off without saving intent', disabledRequests);
function get(member = 'alice', conversation = 'chat', server = app) {
  const request = { url: `/api/conversations/${conversation}/takeover`,
    headers: headers(member, conversation) };
  return server.inject(request);
}
async function participant() {
  await fixture.append('participation-chat', 'participant.added', {
    conversationId: 'chat', participantId: 'bob', addedBy: 'alice',
  }, true);
}
async function checksHttpGuards() {
  await setup();
  const before = await fixture.nats.store.head();
  const url = '/api/conversations/chat/takeover';
  const valid = headers();
  const cases = [
    { headers: { ...valid, cookie: '' }, payload: '{', code: 401 },
    { headers: { cookie: valid.cookie, 'x-csrf-token': valid['x-csrf-token'] },
      payload: '{', code: 403 },
    { headers: { ...valid, 'x-csrf-token': 'wrong' }, payload: body, code: 403 },
    { headers: headers('alice', 'other'), payload: body, code: 403 },
    { headers: headers('alice', 'chat', 'foreign'), payload: body, code: 403 },
    { headers: valid, payload: { ...body, extra: true }, code: 400 },
    { headers: valid, payload: '{', code: 400 },
  ];
  for (const entry of cases) {
    const request = { method: 'POST' as const, url,
      headers: { ...entry.headers, 'content-type': 'application/json' }, payload: entry.payload };
    expect((await app.inject(request)).statusCode).toBe(entry.code);
  }
  expect(await fixture.nats.store.head()).toBe(before);
  expect((await post()).statusCode).toBe(202);
}
it('checks session, Origin and chat-bound CSRF before strict JSON and intent', checksHttpGuards);
async function readsEligibility() {
  await setup();
  await participant();
  const before = await fixture.nats.store.head();
  const alice = await get();
  expect(alice.statusCode).toBe(200);
  expect(alice.json()).toMatchObject({ status: 'none', controlPosition: 0, reason: 'none',
    scope: 'this_conversation', eligibleActions: ['request'], csrf: headers()['x-csrf-token'] });
  expect((await get('bob')).json()).toMatchObject({ eligibleActions: [] });
  expect((await get('alice', 'chat', fixture.app)).json()).toMatchObject({ eligibleActions: [] });
  expect(await fixture.nats.store.head()).toBe(before);
  expect(desktopCalls).toBe(0);
  const refused = await post(body, 'bob');
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ status: 'refused', reason: 'requester_only' });
  expect(await fixture.nats.store.head('computer-assistant')).toBeLessThan(before);
  await fixture.append('participation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });
  expect((await get()).json()).toMatchObject({ eligibleActions: [] });
}
it('offers request only to the latest human author when requests are enabled', readsEligibility);
async function retriesAndLostReplies() {
  await setup();
  await participant();
  const first = await post();
  expect(first.statusCode).toBe(202);
  const before = await fixture.nats.store.head();
  expect((await post()).json()).toEqual(first.json());
  expect(await fixture.nats.store.head()).toBe(before);
  for (const changed of [{ ...body, commandId: 'second-tab' },
    { ...body, requesterEventId: 'changed' }, { ...body, generation: 2 }]) {
    expect((await post(changed)).statusCode).toBe(409);
  }
  expect((await get()).json()).toMatchObject({ status: 'requested', commandId: body.commandId,
    affectedTurnIds: [], eligibleActions: [] });
  const bob = (await get('bob')).json<Record<string, unknown>>();
  expect(bob['commandId']).toBeUndefined();
  expect(bob['affectedTurnIds']).toBeUndefined();
  expect((await get('outsider')).statusCode).toBe(403);
  await fixture.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  expect((await post()).statusCode).toBe(409);
}
it('recovers lost replies, hides private references and rejects changed retry bindings',
  retriesAndLostReplies);
async function checksStateBeforeSaving() {
  await setup();
  const before = await fixture.nats.store.head();
  expect((await post({ ...body, generation: 2 })).statusCode).toBe(409);
  const hidden = await get('outsider');
  expect(hidden.statusCode).toBe(403);
  await fixture.append('computer-assistant', 'computer.suspended', {
    assistantId: 'assistant', computerId: 'desktop',
  });
  const suspended = await fixture.nats.store.head();
  expect((await post()).statusCode).toBe(503);
  expect((await get()).json()).toMatchObject({ eligibleActions: [] });
  expect(await fixture.nats.store.head()).toBe(suspended);
  expect((await get('outsider')).body).toBe(hidden.body);
  expect(suspended).toBeGreaterThan(before);
  await fixture.append('computer-assistant', 'computer.ready', {
    assistantId: 'assistant', computerId: 'desktop', generation: 1,
  });
  expect((await post()).statusCode).toBe(503);
  expect((await get()).json()).toMatchObject({ eligibleActions: [] });
}
it('rejects stale generations and unavailable computers without intent', checksStateBeforeSaving);
async function removedMember() {
  await setup();
  await fixture.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
  await fixture.append('member-alice', 'member.invited', { memberId: 'alice',
    invitationId: 'again', email: 'a@example.test', role: 'member', invitedBy: 'owner' });
  expect((await post()).json()).toEqual({ status: 'refused', reason: 'access_refused' });
  const response = await get();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused', reason: 'access_refused' });
}
it('refuses removed then reinvited members without control fields', removedMember);
async function otherChat() {
  await fixture.append('conversation-other', 'conversation.created', {
    conversationId: 'other', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
  }, true);
  const message = await fixture.append('conversation-other', 'message.posted', {
    conversationId: 'other', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  return { ...body, commandId: 'other-command', requesterEventId: message.id };
}
async function competingRequests() {
  await setup();
  const other = await otherChat();
  const append = fixture.nats.store.append.bind(fixture.nats.store);
  const both = Promise.withResolvers<void>();
  let arrivals = 0;
  async function together(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) both.resolve();
    await both.promise;
    return append(command);
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementation(together);
  const responses = await Promise.all([post(), post(other, 'alice', 'other')]);
  function code(response: typeof responses[number]) { return response.statusCode; }
  const codes = responses.map(code);
  expect(codes.sort()).toEqual([202, 409]);
  let intents = 0;
  for await (const row of fixture.nats.store.readStream('computer-assistant')) {
    if (row.event.type === 'takeover.requested') intents++;
  }
  expect(intents).toBe(1);
}
it('saves exactly one intent when two chats request the same computer at once', competingRequests);
async function privateStatusAndRestart() {
  await setup();
  const other = await otherChat();
  await fixture.append('participation-other', 'participant.added', {
    conversationId: 'other', participantId: 'bob', addedBy: 'alice',
  }, true);
  for (const [conversationId, turnId] of [['chat', body.requesterEventId],
    ['other', other.requesterEventId]] as const) {
    await fixture.append('computer-assistant', 'computer.turn_started', {
      assistantId: 'assistant', computerId: 'desktop', conversationId, turnId,
      threadId: conversationId, requesterId: 'alice', task: 'chat_turn',
    });
  }
  const hidden = await get('bob');
  expect(hidden.statusCode).toBe(403);
  expect((await post()).statusCode).toBe(202);
  const before = await fixture.nats.store.head();
  const first = await get();
  const expected = first.json<Record<string, unknown>>();
  expect(expected['affectedTurnIds']).toEqual([body.requesterEventId]);
  const readOther = await get('bob', 'other');
  expect(readOther.json()).toMatchObject({ status: 'requested', scope: 'other_work' });
  expect(readOther.body).not.toContain(body.requesterEventId);
  expect(readOther.body).not.toContain(body.commandId);
  expect((await get('bob')).body).toBe(hidden.body);
  const chat = { ...fixture, store: fixture.nats.store, silo: 'test' };
  const second = buildServer(fixture.config, { chat, takeoverRequestsEnabled: true });
  try {
    delete expected['serverTime'];
    for (const server of [app, second]) {
      const response = await get('alice', 'chat', server);
      const actual = response.json<Record<string, unknown>>();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(actual['serverTime']).toEqual(expect.any(String));
      delete actual['serverTime'];
      expect(actual).toEqual(expected);
    }
  } finally {
    await second.close();
  }
  expect(await fixture.nats.store.head()).toBe(before);
  expect(desktopCalls).toBe(0);
}
it('returns only own chat turns and stable status across repeated reads and another server',
  privateStatusAndRestart);
async function avoidsConversationReads(method: 'GET' | 'POST') {
  await setup();
  const read = fixture.nats.store.readStream.bind(fixture.nats.store);
  let checking = false;
  async function* wrapped(...args: Parameters<typeof read>) {
    if (args[0] === 'member-alice') checking = true;
    if (checking && args[0].startsWith('conversation-')) {
      throw new Error('Conversation read inside access check');
    }
    yield* read(...args);
  }
  vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(wrapped);
  const response = method === 'GET' ? await get() : await post();
  expect(checking).toBe(true);
  expect(response.statusCode, response.body).toBe(method === 'GET' ? 200 : 202);
}
it.each(['GET', 'POST'] as const)('%s loads conversation history before checking access',
  avoidsConversationReads);
async function laterMessageDuringAccess() {
  await setup();
  const read = fixture.nats.store.readStream.bind(fixture.nats.store);
  let added = false;
  async function* changed(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] !== 'member-alice' || added) return;
    added = true;
    await fixture.append('conversation-chat', 'message.posted', {
      conversationId: 'chat', authorId: 'alice', authorKind: 'human',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
    });
  }
  vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(changed);
  expect((await post()).statusCode).toBe(409);
  expect(added).toBe(true);
}
it('rejects a newer human request arriving during the access check', laterMessageDuringAccess);
async function ordinaryChat(mode: 'direct' | 'group') {
  await setup();
  const details = { conversationId: 'ordinary', mode, createdBy: 'alice',
    participantIds: ['alice', 'bob'] };
  await fixture.append('conversation-ordinary', 'conversation.created', details, true);
  expect((await get('alice', 'ordinary')).json()).toMatchObject({
    status: 'not_applicable', eligibleActions: [], controlPosition: 0,
  });
}
it.each(['direct', 'group'] as const)('returns not_applicable for a %s chat', ordinaryChat);
async function revokedDesktop() {
  await setup();
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner',
  });
  const response = await post();
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused', reason: 'access_refused' });
}
it('reports a saved desktop access revocation as forbidden', revokedDesktop);
async function retryAfterStateChanged(field: 'requesterEventId' | 'generation') {
  await setup();
  expect((await post()).statusCode).toBe(202);
  const changed = { ...body };
  if (field === 'requesterEventId') {
    const message = await fixture.append('conversation-chat', 'message.posted', {
      conversationId: 'chat', authorId: 'alice', authorKind: 'human',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
    });
    changed.requesterEventId = message.id;
  } else {
    await fixture.append('computer-assistant', 'computer.claimed', {
      assistantId: 'assistant', computerId: 'desktop', sandboxUid: 'sandbox',
      generation: 2, tokenId: 'token:second',
    });
    await fixture.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'desktop', generation: 2, podUid: 'second',
    });
    changed.generation = 2;
  }
  expect((await post(changed)).statusCode).toBe(409);
}
it.each(['requesterEventId', 'generation'] as const)(
  'rejects a changed retry %s even when it matches current state', retryAfterStateChanged);

async function overlappingRetries() {
  await setup();
  const append = fixture.nats.store.append.bind(fixture.nats.store);
  const both = Promise.withResolvers<void>();
  let arrivals = 0;
  async function together(command: AppendCommand) {
    arrivals++;
    // Force different generated times without delaying either request.
    command.event.time = new Date(1_800_000_000_000 + arrivals).toISOString();
    if (arrivals === 2) both.resolve();
    await both.promise;
    return append(command);
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementation(together);
  const responses = await Promise.all([post(), post()]);
  expect(arrivals).toBe(2);
  for (const response of responses) expect(response.statusCode).toBe(202);
  expect(responses[0]!.json()).toEqual(responses[1]!.json());
  let intents = 0;
  for await (const row of fixture.nats.store.readStream('computer-assistant')) {
    if (row.event.type === 'takeover.requested') intents++;
  }
  expect(intents).toBe(1);
}
it('returns the same saved command and position for overlapping identical retries',
  overlappingRetries);
