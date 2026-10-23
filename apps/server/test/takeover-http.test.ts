import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as access from '../src/chat/access.ts';
import { computerSummary, encodeSession } from '@opencrane/auth';
import { createEventStore, type AppendCommand } from '@opencrane/event-store';
import { auditTrail, readAudit } from '@opencrane/projections';
import { viewAccess } from '../src/computers/view-access.ts';
import { parseEventByType } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { buildServer, buildProductionServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';
import { takeoverProbe } from './support/takeover-probe.ts';

let fixture: Awaited<ReturnType<typeof viewFixture>>;
let app: ReturnType<typeof buildServer>;
let body: { commandId: string; requesterEventId: string; generation: number };
let desktopCalls = 0;
vi.mock('node:crypto', { spy: true });

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
  const liveView = { ...chat, open: noDesktop };
  const options = { chat, liveView, takeoverRequestsEnabled: requestsEnabled };
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
  expect((await post()).json()).toEqual(first.json());
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
  body = { ...body, commandId: 'fresh-attempt' };
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
async function competingRequests(sameCommand: boolean) {
  await setup();
  const other = await otherChat();
  if (sameCommand) other.commandId = body.commandId;
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
  const retry = responses[0].statusCode === 202 ? await post() : await post(other, 'alice', 'other');
  expect(retry.statusCode).toBe(202);
}
it.each([false, true])('saves one intent for competing chats, same command id: %s',
  competingRequests);
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
    const parsed = parseEventByType(command.event);
    if (!parsed.success) throw new Error('Expected a valid takeover event');
    parsed.event.time = new Date(1_800_000_000_000 + arrivals).toISOString();
    command.event = parsed.event;
    if (arrivals === 2) both.resolve();
    await both.promise;
    return append(command);
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementation(together);
  const responses = await Promise.all([post(), post()]);
  expect(arrivals).toBe(2);
  for (const response of responses) expect(response.statusCode).toBe(202);
  expect(responses[0].json()).toEqual(responses[1].json());
  let intents = 0;
  for await (const row of fixture.nats.store.readStream('computer-assistant')) {
    if (row.event.type === 'takeover.requested') intents++;
  }
  expect(intents).toBe(1);
}
it('returns the same saved command and position for overlapping identical retries',
  overlappingRetries);

async function csrfBeforeLookup(tokenKind: 'length' | 'shape' | 'unequal') {
  await setup();
  const lookup = vi.spyOn(fixture.feed, 'memberId');
  const compare = vi.mocked(crypto.timingSafeEqual);
  compare.mockClear();
  const valid = headers();
  let token = 'a'.repeat(63);
  if (tokenKind === 'shape') token = 'z'.repeat(64);
  if (tokenKind === 'unequal') {
    const first = valid['x-csrf-token'][0] === 'a' ? 'b' : 'a';
    token = first + valid['x-csrf-token'].slice(1);
  }
  const request = { method: 'POST' as const, url: '/api/conversations/chat/takeover',
    headers: { ...valid, 'x-csrf-token': token }, payload: body };
  const response = await app.inject(request);
  expect(response.statusCode).toBe(403);
  expect(lookup).not.toHaveBeenCalled();
  if (tokenKind === 'unequal') {
    expect(compare).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(token, 'hex'), Buffer.from(valid['x-csrf-token'], 'hex'));
  } else {
    expect(compare).not.toHaveBeenCalled();
  }
}
it.each(['length', 'shape', 'unequal'] as const)(
  'rejects a CSRF token with wrong %s before member lookup', csrfBeforeLookup);

async function disabledOrdering() {
  await setup(false);
  const lookup = vi.spyOn(fixture.feed, 'memberId');
  expect((await post({ ...body, extra: true })).statusCode).toBe(400);
  expect((await post()).statusCode).toBe(503);
  expect(lookup).not.toHaveBeenCalled();
}
it('checks the disabled switch after body validation and before member lookup', disabledOrdering);

async function oneReadCheck() {
  await setup();
  const check = vi.spyOn(access, 'chatAccess');
  expect((await get()).statusCode).toBe(200);
  expect(check).toHaveBeenCalledTimes(1);
}
it('checks GET access exactly once', oneReadCheck);

async function terminalStatus(phase: 'paused' | 'failed') {
  await setup();
  expect((await post()).statusCode).toBe(202);
  const binding = { assistantId: 'assistant', computerId: 'desktop', generation: 1,
    podUid: 'fixture', takeoverId: body.commandId, affectedTurnIds: [] };
  if (phase === 'paused') {
    await fixture.append('computer-assistant', 'takeover.pausing', { ...binding,
      bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
      executionProof: 'exited', quietProof: 'unavailable' });
    await fixture.append('computer-assistant', 'takeover.paused', { ...binding,
      bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor', quietProof: 'complete' });
  } else {
    await fixture.append('computer-assistant', 'takeover.failed', {
      ...binding, reason: 'pause_timeout' });
  }
  const position = await fixture.nats.store.head('computer-assistant');
  const response = await get();
  expect(response.statusCode).toBe(200);
  const reason = phase === 'failed' ? 'pause_timeout' : 'requester_requested';
  expect(response.json()).toMatchObject({ status: phase, reason, controlPosition: position,
    scope: 'this_conversation', commandId: body.commandId, eligibleActions: [] });
}
it.each(['paused', 'failed'] as const)('returns saved %s status over HTTP', terminalStatus);

async function productionDisabled() {
  await setup();
  await app.close();
  const chat = { ...fixture, store: fixture.nats.store, silo: 'test' };
  app = buildProductionServer(fixture.config, { chat, takeoverRequestsEnabled: true });
  expect((await post()).statusCode).toBe(503);
}
it('keeps requests disabled in the production route set', productionDisabled);

async function refusalRows() {
  const rows = [];
  for await (const row of fixture.nats.store.readStream(`view-${body.commandId}`)) {
    rows.push(row);
  }
  return rows;
}
async function computerState() {
  const state = computerSummary.empty();
  for await (const row of fixture.nats.store.readStream('computer-assistant')) {
    computerSummary.add(state, row);
  }
  return state;
}
async function recordsSafeRefusal(controller: boolean) {
  await setup();
  await participant();
  await fixture.append('computer-assistant', 'computer.turn_started', {
    assistantId: 'assistant', computerId: 'desktop', conversationId: 'private-chat',
    turnId: 'private-turn-canary', threadId: 'private-thread', requesterId: 'alice',
    task: 'chat_turn',
  });
  if (controller) {
    expect((await post()).statusCode).toBe(202);
    body = { ...body, commandId: 'second-tab' };
  }
  const member = controller ? 'alice' : 'bob';
  const before = await computerState();
  const accessOptions = { ...fixture, silo: 'test', store: fixture.nats.store };
  const viewer = await viewAccess(accessOptions, 'alice', 'chat');
  const bridge = await takeoverProbe(accessOptions);
  expect(bridge.gate).toHaveBeenCalledTimes(controller ? 1 : 0);
  bridge.gate.mockClear();
  const position = await fixture.nats.store.head('computer-assistant');
  const response = await post(body, member);
  expect(response.statusCode).toBe(controller ? 409 : 403);
  const expected = controller ? { status: 'conflict' }
    : { status: 'refused', reason: 'requester_only' };
  expect(response.json()).toEqual(expected);
  expect((await post(body, member)).json()).toEqual(expected);
  const rows = await refusalRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({ type: 'takeover.refused',
    principal: { kind: 'human', id: member }, data: { attemptId: body.commandId,
      actorId: member, reason: controller ? 'control_conflict' : 'requester_only' } });
  expect(rows[0]?.event.data).toHaveProperty('inputDigest', expect.stringMatching(/^[a-f0-9]{64}$/u));
  expect(await computerState()).toEqual(before);
  expect(await viewAccess(accessOptions, 'alice', 'chat')).toMatchObject({
    computerId: viewer.computerId,
  });
  expect(await fixture.nats.store.head('computer-assistant')).toBe(position);
  const after = await fixture.nats.store.head();
  expect((await get(member)).statusCode).toBe(200);
  expect(await fixture.nats.store.head()).toBe(after);
  expect(desktopCalls).toBe(0);
  await bridge.control.send();
  await bridge.control.settled();
  expect(bridge.send).not.toHaveBeenCalled();
  expect(bridge.stopExecution).not.toHaveBeenCalled();
  await fixture.runner.initialise(auditTrail);
  await fixture.runner.run(auditTrail);
  const audit = await readAudit(fixture.db, 'test');
  expect(audit.rows[0]?.records[0]).toMatchObject({ type: 'takeover.refused',
    actor: { kind: 'person', id: member }, reason: controller
      ? 'Control request conflicts with saved state' : 'Only the requester may take control' });
  await fixture.runner.rebuild(auditTrail);
  expect(await readAudit(fixture.db, 'test')).toEqual(audit);
  expect(bridge.gate).not.toHaveBeenCalled();
  expect(bridge.send).not.toHaveBeenCalled();
  expect(bridge.stopExecution).not.toHaveBeenCalled();
  const serialised = JSON.stringify([rows, audit.rows[0], response.json()]);
  for (const forbidden of ['private-turn-canary', 'private-thread', 'private-chat',
    'affectedTurnIds', 'computerId', 'podUid', body.requesterEventId,
    headers(member).cookie, 'ciphertext']) {
    expect(serialised).not.toContain(forbidden);
  }
}
it.each([false, true])('records one safe refusal without changing work, controller=%s',
  recordsSafeRefusal);

async function concurrentRefusals() {
  await setup();
  await participant();
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
  const replies = await Promise.all([post(body, 'bob'), post(body, 'bob')]);
  expect(arrivals).toBe(2);
  for (const reply of replies) expect(reply.statusCode).toBe(403);
  expect(await refusalRows()).toHaveLength(1);
}
it('recovers one refusal for concurrent identical attempts', concurrentRefusals);

async function uncertainRefusal(mode: 'lost' | 'append' | 'read') {
  await setup();
  await participant();
  const append = fixture.nats.store.append.bind(fixture.nats.store);
  let attempted = false;
  async function uncertain(command: AppendCommand): Promise<never> {
    attempted = true;
    if (mode !== 'append') await append(command);
    throw new Error('private-error-canary');
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementation(uncertain);
  const read = fixture.nats.store.readStream.bind(fixture.nats.store);
  async function* unreadable(...args: Parameters<typeof read>) {
    if (mode === 'read' && attempted && args[0].startsWith('view-')) {
      throw new Error('private-read-canary');
    }
    yield* read(...args);
  }
  vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(unreadable);
  const reply = await post(body, 'bob');
  expect(attempted).toBe(true);
  expect(reply.statusCode).toBe(mode === 'lost' ? 403 : 503);
  expect(reply.json()).toEqual(mode === 'lost'
    ? { status: 'refused', reason: 'requester_only' } : { status: 'unavailable' });
  vi.restoreAllMocks();
  expect(await refusalRows()).toHaveLength(mode === 'append' ? 0 : 1);
}
it.each(['lost', 'append', 'read'] as const)(
  'confirms the saved refusal or reports unavailable after %s uncertainty', uncertainRefusal);

async function refusalRestart() {
  await setup();
  await participant();
  expect((await post(body, 'bob')).statusCode).toBe(403);
  const saved = await refusalRows();
  expect(saved).toHaveLength(1);
  await app.close();
  await fixture.nats.stop();
  await fixture.nats.restart();
  const store = await createEventStore(fixture.nats.connection);
  const chat = { ...fixture, store, silo: 'test' };
  app = buildServer(fixture.config, { chat, takeoverRequestsEnabled: true });
  const append = vi.spyOn(store, 'append');
  // Require saved history to answer; broker duplicate detection cannot help here.
  expect((await post(body, 'bob')).statusCode).toBe(403);
  expect(append).not.toHaveBeenCalled();
  for (const changed of [{ ...body, generation: 2 },
    { ...body, requesterEventId: 'changed' }]) {
    expect((await post(changed, 'bob')).statusCode).toBe(409);
  }
  expect((await post(body, 'alice')).statusCode).toBe(409);
  await otherChat();
  expect((await post(body, 'alice', 'other')).statusCode).toBe(409);
  expect(await refusalRows()).toEqual(saved);
  expect(append).not.toHaveBeenCalled();
}
it('recovers refusals after server restart and conflicts on changed actor or request',
  refusalRestart);

async function removalDuringRefusal(stage: 'read' | 'append') {
  await setup();
  await participant();
  const store = fixture.nats.store;
  const read = store.readStream.bind(store);
  const append = store.append.bind(store);
  let removed = false;
  async function removeMember() {
    if (removed) return;
    removed = true;
    await fixture.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'alice',
    });
  }
  async function* removeDuringRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (stage === 'read' && args[0] === `view-${body.commandId}`) await removeMember();
  }
  async function removeDuringAppend(command: AppendCommand) {
    if (stage === 'append') await removeMember();
    return append(command);
  }
  vi.spyOn(store, 'readStream').mockImplementation(removeDuringRead);
  vi.spyOn(store, 'append').mockImplementation(removeDuringAppend);
  const response = await post(body, 'bob');
  expect(removed).toBe(true);
  expect(response.json()).not.toEqual({ status: 'refused', reason: 'requester_only' });
  vi.restoreAllMocks();
  expect(await refusalRows()).toEqual([]);
}
it.each(['read', 'append'] as const)(
  'saves no refusal when membership ends during refusal %s', removalDuringRefusal);

async function retainsAuthorityDeadline() {
  await setup();
  const store = fixture.nats.store;
  const append = store.append.bind(store);
  const read = store.readStream.bind(store);
  let originalDeadline: number | undefined;
  let refusalDeadline: number | undefined;
  let readbackDeadline: number | undefined;
  async function conflict(command: AppendCommand) {
    const parsed = parseEventByType(command.event);
    if (!parsed.success) throw new Error('Expected a valid event');
    if (parsed.event.type === 'takeover.requested') {
      originalDeadline = command.deadline;
      return { status: 'conflict' as const };
    }
    refusalDeadline = command.deadline;
    return append(command);
  }
  async function* readback(...args: Parameters<typeof read>) {
    if (refusalDeadline && args[0] === `view-${body.commandId}`) readbackDeadline = args[2];
    yield* read(...args);
  }
  vi.spyOn(store, 'append').mockImplementation(conflict);
  vi.spyOn(store, 'readStream').mockImplementation(readback);
  expect((await post()).statusCode).toBe(409);
  expect(originalDeadline).toBeTypeOf('number');
  expect(refusalDeadline).toBe(originalDeadline);
  expect(readbackDeadline).toBe(originalDeadline);
  expect(await refusalRows()).toHaveLength(1);
}
it('keeps the checked authority deadline after an intent append conflicts',
  retainsAuthorityDeadline);

async function racesAcceptedAndRefused(first: 'requested' | 'refused') {
  await setup();
  const stale = { ...body, generation: 2 };
  const append = fixture.nats.store.append.bind(fixture.nats.store);
  const both = Promise.withResolvers<void>();
  const firstSaved = Promise.withResolvers<void>();
  let arrivals = 0;
  async function ordered(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) both.resolve();
    await both.promise;
    const parsed = parseEventByType(command.event);
    if (!parsed.success) throw new Error('Expected a valid event');
    if (parsed.event.type !== `takeover.${first}`) await firstSaved.promise;
    const result = await append(command);
    if (parsed.event.type === `takeover.${first}`) firstSaved.resolve();
    return result;
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementation(ordered);
  const replies = await Promise.all([post(), post(stale)]);
  vi.restoreAllMocks();
  const saved = await refusalRows();
  for await (const row of fixture.nats.store.readStream('computer-assistant')) {
    if (row.event.type === 'takeover.requested') saved.push(row);
  }
  expect(saved).toHaveLength(1);
  expect(saved[0]?.event.type).toBe(`takeover.${first}`);
  expect(replies[0]?.statusCode).toBe(first === 'requested' ? 202 : 409);
  expect(replies[1]?.statusCode).toBe(409);
  const before = await fixture.nats.store.head();
  expect((await post()).json()).toEqual(replies[0]?.json());
  expect((await post(stale)).json()).toEqual(replies[1]?.json());
  expect(await fixture.nats.store.head()).toBe(before);
}
it.each(['requested', 'refused'] as const)(
  'saves one outcome when acceptance and refusal race, %s first', racesAcceptedAndRefused);
