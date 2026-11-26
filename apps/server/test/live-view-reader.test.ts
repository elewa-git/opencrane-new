import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { until } from '@opencrane/authz/testing';
import { memberAuthorisation } from '@opencrane/authz';
import { conversations } from '@opencrane/projections';
import { objectId, TupleClient } from '../../../libs/authz/src/client.ts';
import { buildServer } from '../src/server.ts';
import { nextBinaryMessage } from './support/rfb-viewer.ts';
import { holdOpenFgaReply } from './support/view-read-permission.ts';
import { viewFixture } from './support/view-fixture.ts';
import { sharedChildChat, teamViewChat, viewHeaders } from './support/view-requests.ts';

const greeting = Buffer.from('RFB 003.008\n');
type Fixture = Awaited<ReturnType<typeof viewFixture>>;
type Headers = ReturnType<typeof viewHeaders>;

function openDesktop() {
  const desktop = new PassThrough();
  desktop.write(greeting);
  return Promise.resolve(desktop);
}

function messages(fixture: Fixture, chat: string, headers: Headers) {
  return fixture.app.inject({ url: `/api/conversations/${chat}/messages`, headers });
}

function view(fixture: Fixture, chat: string, headers: Headers) {
  return fixture.app.inject({ method: 'POST', url: `/api/conversations/${chat}/view`, headers });
}

async function ticket(fixture: Fixture, chat: string, headers: Headers) {
  const admission = await view(fixture, chat, headers);
  expect(admission.statusCode, admission.body).toBe(200);
  return admission.json<{ ticket: string }>().ticket;
}

function connect(address: string, chat: string, key: string, headers: Headers) {
  const url = `${address.replace('http:', 'ws:')}/ws/conversations/${chat}/view`;
  return new WebSocket(url, ['binary', key], { headers });
}

async function expectUpgradeRefusal(socket: WebSocket) {
  const refused = Promise.withResolvers<number | undefined>();
  const bytes = vi.fn();
  socket.on('message', bytes);
  const timeout = setTimeout(function expired() {
    refused.reject(new Error('The upgrade did not return an HTTP refusal'));
  }, 2000);
  socket.once('unexpected-response', function response(_request, reply) {
    refused.resolve(reply.statusCode);
    reply.resume();
  });
  socket.once('open', function accepted() {
    refused.resolve(101);
  });
  socket.once('error', refused.reject);
  try {
    expect(await refused.promise).toBe(403);
    expect(bytes).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timeout);
    socket.terminate();
  }
}

async function expectReaderStatus(fixture: Fixture, chat: string, headers: Headers,
  historyStatus = 403) {
  expect((await messages(fixture, chat, headers)).statusCode).toBe(historyStatus);
  const refused = await view(fixture, chat, headers);
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).not.toHaveProperty('ticket');
}

async function applyTeamReaderRefusal(fixture: Fixture, change: 'team' | 'receipt' | 'acts_for') {
  const { append, binding } = fixture;
  if (change === 'team') {
    await append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'alice', removedBy: 'bob',
    });
    return;
  }
  const client = new TupleClient(binding);
  if (change === 'acts_for') {
    const assistant = objectId('assistant', 'test', 'team-sales');
    const tuples = await client.read({ object: assistant, relation: 'acts_for' });
    expect(tuples).toHaveLength(1);
    await client.write([], tuples);
  } else {
    const subject = 'assistant-team-sales';
    const sequence = await fixture.nats.store.head(subject);
    const { event } = await fixture.nats.store.readEvent(sequence);
    const receipt = { user: objectId('silo', 'test'), relation: 'applied',
      object: objectId('projection_event', 'test', event.id) };
    await client.write([], [receipt]);
  }
}

async function comparesTeamReaderAtEveryStage(change: 'team' | 'receipt' | 'acts_for') {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { app, config, runner } = fixture;
  const chat = 'team-session';
  let socket: WebSocket | undefined;
  try {
    await teamViewChat(fixture);
    await runner.run(conversations);
    const headers = viewHeaders(config);
    expect((await messages(fixture, chat, headers)).statusCode).toBe(200);
    const live = await ticket(fixture, chat, headers);
    const pending = await ticket(fixture, chat, headers);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = connect(address, chat, live, headers);
    expect(await nextBinaryMessage(socket)).toEqual(greeting);
    const at = performance.now();
    const closed = observeClose(socket);
    await applyTeamReaderRefusal(fixture, change);
    const historyStatus = change === 'receipt' ? 503 : 403;
    await expectReaderStatus(fixture, chat, headers, historyStatus);
    await expectUpgradeRefusal(connect(address, chat, pending, headers));
    await expectAccessClose(closed, at);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}

it.each(['team', 'receipt', 'acts_for'] as const)(
  'uses the message reader for team %s at admission, upgrade and renewal',
  comparesTeamReaderAtEveryStage, 30_000,
);

function observeClose(socket: WebSocket) {
  let code: number | undefined;
  let closedAt: number | undefined;
  socket.on('close', function close(status: number) {
    code = status;
    closedAt = performance.now();
  });
  return function readClose() {
    return { code, closedAt };
  };
}

async function expectAccessClose(close: ReturnType<typeof observeClose>, started: number) {
  function closed() {
    return close().closedAt !== undefined;
  }
  await until(closed, 2000);
  const { code, closedAt } = close();
  expect(code).toBe(4003);
  expect(closedAt! - started).toBeLessThan(2000);
}

type ChildChange = 'reader parent join' | 'creator parent join' | 'creator membership';

async function removeInheritedAccess(fixture: Fixture, change: ChildChange) {
  if (change === 'creator membership') {
    await fixture.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'bob' });
  } else {
    const participantId = change === 'reader parent join' ? 'bob' : 'alice';
    const conversationId = 'parent';
    await fixture.append('participation-parent', 'participant.removed', {
      conversationId, participantId, removedBy: 'alice',
    });
    // Restore current parent participation to isolate its original join.
    await fixture.append('participation-parent', 'participant.added', {
      conversationId, participantId, addedBy: 'alice',
    });
  }
}

async function comparesInheritedChildReader(change: ChildChange) {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { app, config, runner } = fixture;
  let socket: WebSocket | undefined;
  try {
    await sharedChildChat(fixture);
    await runner.run(conversations);
    const headers = viewHeaders(config, 'bob');
    expect((await messages(fixture, 'child', headers)).statusCode).toBe(200);
    const live = await ticket(fixture, 'child', headers);
    const pending = await ticket(fixture, 'child', headers);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = connect(address, 'child', live, headers);
    expect(await nextBinaryMessage(socket)).toEqual(greeting);
    const at = performance.now();
    const closed = observeClose(socket);
    await removeInheritedAccess(fixture, change);
    await expectReaderStatus(fixture, 'child', headers);
    await expectUpgradeRefusal(connect(address, 'child', pending, headers));
    await expectAccessClose(closed, at);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}

it.each(['reader parent join', 'creator parent join', 'creator membership'] as const)(
  'uses the message reader after inherited child access loses its %s',
  comparesInheritedChildReader, 30_000,
);

async function verifiesExplicitChildJoin() {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { app, append, binding, config, runner } = fixture;
  let socket: WebSocket | undefined;
  try {
    await sharedChildChat(fixture);
    const conversationId = 'child';
    const participantId = 'bob';
    const contextKind = 'shared_child';
    const auth = memberAuthorisation(binding);
    await append('participation-child', 'participant.removed', {
      conversationId, participantId, contextKind, reviewPosition: 3, removedBy: 'alice',
    }, true);
    await append('participation-child', 'participant.added', {
      conversationId, participantId, addedBy: 'alice',
    }, true);
    await runner.run(conversations);
    const headers = viewHeaders(config, 'bob');
    expect((await auth.conversation('bob', 'child', 'read')).allowed).toBe(true);
    await expectReaderStatus(fixture, 'child', headers);
    await append('participation-child', 'participant.removed', {
      conversationId, participantId, contextKind, reviewPosition: 4, removedBy: 'alice',
    }, true);
    const addition = await append('participation-child', 'participant.added', {
      conversationId, participantId, contextKind, joinKind: 'explicit_child',
      reviewPosition: 5, addedBy: 'alice',
    }, true);
    const receipt = { user: objectId('silo', 'test'), relation: 'applied',
      object: objectId('projection_event', 'test', addition.id) };
    const client = new TupleClient(binding);
    await runner.run(conversations);
    const live = await ticket(fixture, 'child', headers);
    const pending = await ticket(fixture, 'child', headers);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = connect(address, 'child', live, headers);
    expect(await nextBinaryMessage(socket)).toEqual(greeting);
    const at = performance.now();
    const closed = observeClose(socket);
    await client.write([], [receipt]);
    expect((await auth.conversation('bob', 'child', 'read')).allowed).toBe(true);
    await expectReaderStatus(fixture, 'child', headers, 425);
    await expectUpgradeRefusal(connect(address, 'child', pending, headers));
    await expectAccessClose(closed, at);
    await client.write([receipt], []);
    await removeInheritedAccess(fixture, 'reader parent join');
    expect((await messages(fixture, 'child', headers)).statusCode).toBe(200);
    await ticket(fixture, 'child', headers);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}
it('requires both a valid explicit child join and its applied receipt',
  verifiesExplicitChildJoin, 30_000);

async function refusesDifferentTicketBinding() {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { app, config, append, runner } = fixture;
  try {
    await append('participation-chat', 'participant.added', {
      conversationId: 'chat', participantId: 'bob', addedBy: 'alice',
    }, true);
    await append('conversation-other', 'conversation.created', {
      conversationId: 'other', mode: 'agent_session', createdBy: 'alice',
      assistantId: 'assistant',
    }, true);
    await runner.run(conversations);
    const alice = viewHeaders(config);
    const bob = viewHeaders(config, 'bob');
    expect((await messages(fixture, 'chat', bob)).statusCode).toBe(200);
    expect((await messages(fixture, 'other', alice)).statusCode).toBe(200);
    const wrongMember = await ticket(fixture, 'chat', alice);
    const wrongChat = await ticket(fixture, 'chat', alice);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expectUpgradeRefusal(connect(address, 'chat', wrongMember, bob));
    await expectUpgradeRefusal(connect(address, 'other', wrongChat, alice));
    expect(open).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
}
it('sends zero bytes when a viewer ticket belongs to another member or chat',
  refusesDifferentTicketBinding, 30_000);

type ComputerChange = 'state' | 'assistant' | 'computer' | 'generation';
async function refusesDifferentComputer(change: ComputerChange) {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { app, config, append } = fixture;
  try {
    const headers = viewHeaders(config);
    const admitted = await ticket(fixture, 'chat', headers);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const subject = 'computer-assistant';
    if (change === 'state') {
      await append(subject, 'computer.resumed', {
        assistantId: 'assistant', computerId: 'desktop', generation: 1, tokenId: 'token:resumed',
      });
    } else {
      const assistantId = change === 'assistant' ? 'different' : 'assistant';
      const computerId = change === 'computer' ? 'different' : 'desktop';
      const generation = change === 'generation' ? 2 : 1;
      await append(subject, 'computer.ready', { assistantId, computerId, generation });
    }
    expect((await messages(fixture, 'chat', headers)).statusCode).toBe(200);
    expect((await view(fixture, 'chat', headers)).statusCode).toBe(403);
    await expectUpgradeRefusal(connect(address, 'chat', admitted, headers));
    expect(open).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
}
it.each(['state', 'assistant', 'computer', 'generation'] as const)(
  'refuses a ready viewer ticket after a change to the computer %s',
  refusesDifferentComputer, 30_000,
);

async function refusesNonAssistantChat() {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const read = vi.spyOn(fixture.nats.store, 'readStream');
  try {
    await fixture.append('conversation-direct', 'conversation.created', {
      conversationId: 'direct', mode: 'direct', createdBy: 'alice',
      participantIds: ['alice', 'bob'],
    }, true);
    await fixture.runner.run(conversations);
    const headers = viewHeaders(fixture.config);
    expect((await messages(fixture, 'direct', headers)).statusCode).toBe(200);
    expect((await view(fixture, 'direct', headers)).statusCode).toBe(403);
    function readsComputer([subject]: Parameters<typeof fixture.nats.store.readStream>) {
      return subject.startsWith('computer-');
    }
    expect(read.mock.calls.some(readsComputer)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await fixture.close();
  }
}
it('opens a computer only for an assistant chat', refusesNonAssistantChat, 30_000);

async function refusesForeignViewerBinding() {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { config, binding, nats: { store }, db, feed } = fixture;
  const chat = { silo: 'test', binding, store, db, feed };
  const liveView = { ...chat, binding: { ...binding, silo: 'another' }, open };
  const mismatched = buildServer(config, { chat, liveView });
  const read = vi.spyOn(store, 'readStream');
  try {
    const headers = viewHeaders(config);
    const response = await mismatched.inject({ url: '/api/conversations/chat/messages', headers });
    expect(response.statusCode).toBe(200);
    read.mockClear();
    const admission = await mismatched.inject({ method: 'POST',
      url: '/api/conversations/chat/view', headers });
    expect(admission.statusCode).toBe(403);
    function checksChat([subject]: Parameters<typeof store.readStream>) {
      return subject === 'participation-chat' || subject === 'conversation-chat';
    }
    expect(read.mock.calls.some(checksChat)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    await mismatched.close();
    await fixture.close();
  }
}
it('refuses a viewer configured with another silo binding', refusesForeignViewerBinding, 30_000);

type Removal = 'member' | 'participant';

async function refusesLatePrivatePermission(removal: Removal) {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { binding, config, runner, append } = fixture;
  const assistant = objectId('assistant', 'test', 'team-sales');
  const proxy = await holdOpenFgaReply(binding.apiUrl, assistant, 'acts_for');
  try {
    await teamViewChat(fixture);
    await runner.run(conversations);
    const headers = viewHeaders(config);
    const chat = 'team-session';
    expect((await messages(fixture, chat, headers)).statusCode).toBe(200);
    binding.apiUrl = proxy.apiUrl;
    const requests = [messages(fixture, chat, headers), view(fixture, chat, headers)];
    await proxy.observed;
    if (removal === 'member') {
      await append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'bob' });
    } else {
      await append('participation-team-session', 'participant.removed', {
        conversationId: chat, participantId: 'alice', removedBy: 'bob',
      });
    }
    proxy.release();
    const [history, admission] = await Promise.all(requests);
    expect(history?.statusCode).toBe(403);
    expect(admission?.statusCode).toBe(403);
    expect(admission?.json()).not.toHaveProperty('ticket');
    expect(open).not.toHaveBeenCalled();
  } finally {
    await proxy.close();
    await fixture.close();
  }
}
it.each(['member', 'participant'] as const)(
  'rechecks %s removal after the private assistant permission replies',
  refusesLatePrivatePermission, 30_000,
);

async function checksMembershipAfterSiloPermission(membership: 'active' | 'removed') {
  const open = vi.fn(openDesktop);
  const fixture = await viewFixture(open);
  const { append, binding, config, nats } = fixture;
  const silo = objectId('silo', binding.silo);
  const proxy = await holdOpenFgaReply(binding.apiUrl, silo, 'member', 1);
  const sampled = Promise.withResolvers<void>();
  const store = nats.store;
  const head = store.head.bind(store);
  let memberPositions = 0;
  async function sampleMemberPosition(...args: Parameters<typeof head>) {
    const position = await head(...args);
    // Let the chat check sample membership before releasing the silo permission reply.
    if (args[0] === 'member-alice' && ++memberPositions === 2) {
      sampled.resolve();
    }
    return position;
  }
  const headSpy = vi.spyOn(store, 'head');
  try {
    const headers = viewHeaders(config);
    binding.apiUrl = proxy.apiUrl;
    headSpy.mockImplementation(sampleMemberPosition);
    const admission = view(fixture, 'chat', headers);
    await Promise.all([proxy.observed, sampled.promise]);
    if (membership === 'removed') {
      await append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'bob' });
    }
    proxy.release();
    const response = await admission;
    if (membership === 'removed') {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toHaveProperty('status', 'refused');
      expect(response.json()).not.toHaveProperty('ticket');
    } else {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('ticket');
    }
    expect(open).not.toHaveBeenCalled();
  } finally {
    headSpy.mockRestore();
    await proxy.close();
    await fixture.close();
  }
}
it.each(['active', 'removed'] as const)(
  'checks %s personal membership after the silo permission replies',
  checksMembershipAfterSiloPermission, 30_000,
);
