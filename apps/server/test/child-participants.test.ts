import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { OpenFgaClient } from '@openfga/sdk';
import { rebuildMembers } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { conversations, members } from '@opencrane/projections';
import { chatMessageSchema, chatParticipantsSchema } from '@opencrane/protocol';
import { attachWebSocketServer } from '../src/websocket.ts';
import { childFixture, childSession } from './support/child-fixture.ts';

type Fixture = Awaited<ReturnType<typeof childFixture>>;

async function join(context: Fixture, memberId: string, role = 'member') {
  const invitation = { memberId, invitationId: `invite-${memberId}`,
    email: `${memberId}@example.test`, role, invitedBy: 'alice',
    invitedIdentity: { issuer: context.config.issuerUrl, sub: memberId } };
  await context.append(`member-${memberId}`, 'member.invited', invitation, false);
  const membership = { memberId, invitationId: invitation.invitationId,
    email: invitation.email, displayName: memberId, role };
  await context.append(`member-${memberId}`, 'member.joined', membership);
  await context.runner.run(members);
}

async function request(context: Fixture, payload?: unknown, memberId = 'alice',
  conversationId = 'child', path = 'participants') {
  const options = { method: payload ? 'POST' as const : 'GET' as const,
    url: `/api/conversations/${conversationId}/${path}`, headers: context.headers(memberId),
    ...(payload ? { payload } : {}) };
  return context.app.inject(options);
}

async function position(context: Fixture) {
  const response = await request(context);
  expect(response.statusCode, response.body).toBe(200);
  return chatParticipantsSchema.parse(response.json()).accessPosition;
}

function invitation(expectedAccessPosition: number, participantId = 'jane', id = 'invite-jane') {
  return { id, action: 'add', participantId, expectedAccessPosition,
    historyReleaseAcknowledged: true };
}

async function apply(context: Fixture, sequence: number) {
  const saved = await context.nats.store.readEvent(sequence);
  await context.runner.run(conversations);
  await context.auth.handler.handle(saved.event, context.db);
  return saved;
}

async function inviteAndRecover() {
  const context = await childFixture();
  try {
    await childSession(context);
    await join(context, 'jane');
    const reviewed = await position(context);
    const input = invitation(reviewed);
    const client = new OpenFgaClient(context.options.binding);
    const before = await client.read({});
    const response = await request(context, input);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<{ sequence: number }>();
    const row = await apply(context, saved.sequence);
    expect(row.event.data).toEqual({ conversationId: 'child', participantId: 'jane',
      addedBy: 'alice', contextKind: 'shared_child', joinKind: 'explicit_child',
      reviewPosition: reviewed });
    const after = await client.read({});
    function newTuple(tuple: (typeof after.tuples)[number]) {
      function same(previous: (typeof before.tuples)[number]) {
        return JSON.stringify(previous.key) === JSON.stringify(tuple.key);
      }
      return !before.tuples.some(same);
    }
    const added = after.tuples.filter(newTuple);
    expect(added).toHaveLength(2);
    function isParticipant(tuple: (typeof added)[number]) {
      return tuple.key.relation === 'participant';
    }
    const participantTuple = added.find(isParticipant);
    expect(participantTuple?.key.user).toBe(
      `person:${Buffer.from(JSON.stringify(['test', 'jane'])).toString('base64url')}`);
    expect(participantTuple?.key.object).toBe(
      `conversation:${Buffer.from(JSON.stringify(['test', 'child'])).toString('base64url')}`);
    expect(await context.auth.applied(input.id)).toBe(true);
    expect((await context.auth.conversation('jane', 'child', 'read')).allowed).toBe(true);
    expect((await context.auth.conversation('jane', 'parent', 'read')).allowed).toBe(false);
    const retry = await request(context, input);
    expect(retry.json()).toEqual(response.json());
    const changed = { ...input, expectedAccessPosition: saved.sequence };
    expect((await request(context, changed)).statusCode).toBe(409);
    const changedTarget = { ...input, participantId: 'bob' };
    expect((await request(context, changedTarget)).statusCode).toBe(409);
    expect(await context.nats.store.head('participation-child')).toBe(saved.sequence);
    const receipt = await request(context, undefined, 'jane', 'child', `changes/${input.id}`);
    expect(receipt.json()).toMatchObject({ status: 'appended', sequence: saved.sequence,
      projection: { content: 'current', iam: 'current' } });
    const history = await request(context, undefined, 'jane', 'child', 'messages');
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain('Hello shared history');
    for (const path of ['messages', 'participants', 'files', 'approvals']) {
      const parent = await request(context, undefined, 'jane', 'parent', path);
      const foreign = await request(context, undefined, 'jane', 'foreign', path);
      expect(parent.statusCode).toBe(403);
      expect(parent.body).toBe(foreign.body);
    }
    const people = await request(context, undefined, 'jane');
    expect(people.json()).toMatchObject({ canManage: false, canLeave: true });
    await context.runner.rebuild(conversations);
    expect((await request(context, undefined, 'jane')).json()).toEqual(people.json());
    const verification = { verifyAgainst: context.options.binding };
    const rebuilt = await rebuildMembers(context.fga.apiUrl, 'test', context.nats.reader, verification);
    expect(rebuilt.verified).toBe(true);
  } finally {
    await context.close();
  }
}
it('invites with reviewed history, recovers one saved join and replays only child rights',
  inviteAndRecover, 120_000);

async function refusesInvitations() {
  const context = await childFixture();
  try {
    await childSession(context);
    await join(context, 'jane', 'admin');
    const reviewed = await position(context);
    const input = invitation(reviewed);
    const missingAcknowledgement = { ...input, historyReleaseAcknowledged: undefined };
    expect((await request(context, missingAcknowledgement)).statusCode).toBe(400);
    const falseAcknowledgement = { ...input, historyReleaseAcknowledged: false };
    expect((await request(context, falseAcknowledgement)).statusCode).toBe(400);
    expect((await request(context, input, 'alice', 'parent')).statusCode).toBe(400);
    const promotion = { memberId: 'bob', previousRole: 'member', newRole: 'admin',
      changedBy: 'alice' };
    await context.append('member-bob', 'member.role_changed', promotion);
    expect((await request(context, input, 'bob')).statusCode).toBe(403);
    const removeOther = { id: 'bob-removes', action: 'remove', participantId: 'alice',
      expectedAccessPosition: reviewed };
    expect((await request(context, removeOther, 'bob')).statusCode).toBe(403);
    const leave = { id: 'creator-leave', action: 'leave', expectedAccessPosition: reviewed };
    expect((await request(context, leave)).statusCode).toBe(403);
    expect((await request(context, input, 'jane')).statusCode).toBe(403);
    expect((await request(context, invitation(reviewed - 1))).statusCode).toBe(409);
    expect((await request(context, invitation(reviewed, 'bob'))).statusCode).toBe(409);
    expect((await request(context, invitation(reviewed, 'missing'))).statusCode).toBe(403);
    await context.append('member-jane', 'member.removed', {
      memberId: 'jane', removedBy: 'alice',
    }, false);
    expect((await request(context, input)).statusCode).toBe(403);
    await join(context, 'eve');
    const close = { conversationId: 'child', closedBy: 'alice' };
    await context.append('participation-child', 'conversation.closed', close, false);
    const closedPosition = await context.nats.store.head('participation-child');
    expect((await request(context, invitation(reviewed, 'eve'))).statusCode).toBe(409);
    expect(await context.nats.store.head('participation-child')).toBe(closedPosition);
  } finally {
    await context.close();
  }
}
it('requires the creator, acknowledgement, current review, active target and open child',
  refusesInvitations, 120_000);

async function removesAndLeaves(action: string) {
  const context = await childFixture();
  let closeSocket: (() => Promise<void>) | undefined;
  try {
    await childSession(context);
    await join(context, 'jane');
    const added = await request(context, invitation(await position(context)));
    expect(added.statusCode, added.body).toBe(200);
    const sequence = added.json<{ sequence: number }>().sequence;
    await apply(context, sequence);
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = { feed: context.feed, binding: context.options.binding, chat: context.options };
    const wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
    const socketOptions = { headers: context.headers('jane') };
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, socketOptions);
    const received: unknown[] = [];
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const subscription = { type: 'subscribe', topic: 'conversation', conversationId: 'child', since: 0 };
    socket.send(JSON.stringify(subscription));
    function hasHistory() {
      return JSON.stringify(received).includes('Hello shared history');
    }
    await until(hasHistory);
    async function close() {
      socket.terminate();
      function stop(resolve: () => void) { wss.close(resolve); }
      await new Promise<void>(stop);
    }
    closeSocket = close;
    const closed = once(socket, 'close');
    const removal = { id: 'end-join', action, expectedAccessPosition: sequence,
      ...(action === 'remove' ? { participantId: 'jane' } : {}) };
    let actor = 'alice';
    if (action === 'leave') actor = 'jane';
    const started = performance.now();
    const removed = await request(context, removal, actor);
    expect(removed.statusCode, removed.body).toBe(200);
    await closed;
    const denied = await request(context, undefined, 'jane', 'child', 'messages');
    expect(denied.statusCode).toBe(403);
    expect(performance.now() - started).toBeLessThan(2000);
    expect((await context.auth.conversation('jane', 'child', 'read')).allowed).toBe(true);
    const saved = await context.nats.store.readEvent(removed.json<{ sequence: number }>().sequence);
    expect(saved.event.data).toEqual({ conversationId: 'child', participantId: 'jane',
      removedBy: actor, contextKind: 'shared_child', reviewPosition: sequence });
    const parentJoin = { conversationId: 'parent', participantId: 'jane', addedBy: 'alice' };
    await context.append('participation-parent', 'participant.added', parentJoin);
    const parentRemoval = { conversationId: 'parent', participantId: 'jane', removedBy: 'alice' };
    await context.append('participation-parent', 'participant.removed', parentRemoval);
    await context.append('participation-parent', 'participant.added', parentJoin);
    expect((await request(context, undefined, 'jane')).statusCode).toBe(403);
    const rejoined = await request(context, invitation(await position(context), 'jane', 'reinvite'));
    expect(rejoined.statusCode).toBe(200);
    await apply(context, rejoined.json<{ sequence: number }>().sequence);
    expect((await request(context, undefined, 'jane')).statusCode).toBe(200);
  } finally {
    await closeSocket?.();
    await context.close();
  }
}
it.each(['remove', 'leave'])('ends HTTP and socket reads before IAM on child %s',
  removesAndLeaves, 120_000);

async function refusesChangedAuthority(removal: string) {
  const context = await childFixture();
  const originalHead = context.nats.store.head.bind(context.nats.store);
  const query = context.db.query.bind(context.db);
  try {
    await childSession(context);
    await join(context, 'jane');
    const reviewed = await position(context);
    let delayed = false;
    async function slowClose<Row extends Record<string, unknown>>(sql: string,
      parameters?: unknown[]) {
      if (!delayed && sql.includes("type = 'conversation.closed'")) {
        delayed = true;
        await delay(2200);
      }
      return query<Row>(sql, parameters);
    }
    async function removeCreator() {
      if (removal === 'silo') {
        const data = { memberId: 'alice', removedBy: 'bob' };
        await context.append('member-alice', 'member.removed', data, false);
      } else {
        const data = { conversationId: 'parent', participantId: 'alice', removedBy: 'bob' };
        await context.append('participation-parent', 'participant.removed', data, false);
      }
    }
    if (removal !== 'during-write') await removeCreator();
    const watched = new Set<string>();
    let writing = false;
    async function changingHead(subject?: string, deadline?: number) {
      if (subject === undefined) writing = true;
      if (writing && subject) watched.add(subject);
      if (writing && subject === 'participation-parent') await removeCreator();
      return originalHead(subject, deadline);
    }
    context.db.query = slowClose;
    if (removal === 'during-write') context.nats.store.head = changingHead;
    const response = await request(context, invitation(reviewed));
    let expected = 403;
    if (removal === 'during-write') {
      expected = 409;
      expect(delayed).toBe(true);
      expect([...watched].sort()).toEqual([
        'member-alice', 'member-jane', 'participation-child', 'participation-parent',
      ]);
    }
    expect(response.statusCode, response.body).toBe(expected);
    expect(await originalHead('participation-child')).toBe(0);
  } finally {
    context.nats.store.head = originalHead;
    context.db.query = query;
    await context.close();
  }
}
it.each(['parent', 'silo', 'during-write'])(
  'refuses creator departure (%s), with only small streams in the final write check',
  refusesChangedAuthority, 120_000);

async function requiresPermissionAndSpace() {
  const context = await childFixture();
  try {
    await childSession(context);
    await join(context, 'jane');
    const reviewed = await position(context);
    const client = new OpenFgaClient(context.options.binding);
    const personId = Buffer.from(JSON.stringify(['test', 'alice'])).toString('base64url');
    const childId = Buffer.from(JSON.stringify(['test', 'child'])).toString('base64url');
    const creator = { user: `person:${personId}`, relation: 'creator',
      object: `conversation:${childId}` };
    await client.write({ deletes: [creator] });
    expect((await context.auth.conversation('alice', 'child', 'read')).allowed).toBe(true);
    expect((await request(context, invitation(reviewed))).statusCode).toBe(403);
    await client.write({ writes: [creator] });
    for (let index = 0; index < 95; index++) {
      const data = { conversationId: 'child', participantId: `person-${index}`, addedBy: 'alice',
        contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: reviewed };
      await context.append('participation-child', 'participant.added', data, false);
    }
    const fullPosition = await position(context);
    expect((await request(context, invitation(fullPosition))).statusCode).toBe(409);
    expect(await context.nats.store.head('participation-child')).toBe(fullPosition);
  } finally {
    await context.close();
  }
}
it('requires OpenFGA management permission and refuses a 98th recorded participant',
  requiresPermissionAndSpace, 120_000);
