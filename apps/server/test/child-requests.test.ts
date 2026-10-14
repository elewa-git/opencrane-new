import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { computers, conversations, connectMemberFeed, pgDb, ProjectionRunner, readConversation }
  from '@opencrane/projections';
import { childRequestedDataSchema } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { reviewChildRequest, requestChild, createRequestedChild }
  from '../src/chat/child-requests.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let options: Parameters<typeof reviewChildRequest>[0];
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let directory: string;
let counter = 0;
async function save(subject: string, type: string, data: unknown, apply = true) {
  const saved = { ...event(`fixture-${++counter}`, subject, type), data };
  const command = { event: saved, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) await auth.handler.handle(saved, options.db);
  return saved;
}
async function initialise() {
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
  directory = await mkdtemp(`${tmpdir()}/child-requests-`);
  const db = pgDb(storage.queue);
  const binding = await createStore(fga.apiUrl, 'test');
  options = { silo: 'test', store: nats.store, db, binding };
  auth = memberAuthorisation(binding, nats.store);
  runner = new ProjectionRunner(db, nats.reader, createLogger('child-test'));
  await runner.initialise(computers);
  await runner.initialise(conversations);
  for (const memberId of ['alice', 'bob', 'carol']) {
    await save(`member-${memberId}`, 'member.joined', { memberId, role: 'member',
      email: `${memberId}@example.test`, displayName: memberId });
  }
  for (const teamId of ['owners', 'payer']) {
    await save(`team-${teamId}`, 'team.created', { teamId, name: teamId, createdBy: 'alice' });
    await save(`team-${teamId}`, 'team.member_added', { teamId, memberId: 'alice', addedBy: 'alice' });
  }
  await save('assistant-assistant', 'assistant.created', { assistantId: 'assistant',
    ownerId: 'owners', kind: 'team', payingGroupId: 'payer' });
}
beforeAll(initialise, 60_000);
async function close() {
  await nats?.close();
  await storage?.close();
  await fga?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
afterAll(close);
async function parent(mode = 'group', author = 'alice', lost = false) {
  const conversationId = `parent-${++counter}`;
  let data: object = { conversationId, createdBy: 'alice', mode,
    participantIds: ['alice', 'bob', 'carol'] };
  if (mode === 'agent_session') {
    data = { conversationId, createdBy: 'alice', mode, assistantId: 'assistant' };
  }
  if (mode === 'direct') data = { ...data, participantIds: ['alice', 'bob'] };
  await save(`conversation-${conversationId}`, 'conversation.created', data);
  const keys = conversationKeys(directory);
  keys.provision('test', conversationId);
  const input = { id: `source-${counter}`, conversationId, text: '@Assistant source canary' };
  const context = { silo: 'test', memberId: author };
  async function post() {
    return chatCommand(nats.store, keys, context, input);
  }
  if (lost) await loseReply(post);
  await post();
  await runner.run(conversations);
  return { conversationId, sourceMessageId: input.id, requestId: `request-${counter}`,
    assistantId: 'assistant', payingGroupId: 'payer', participantIds: ['alice', 'bob'] };
}
async function refusesSource(mode: string, author: string) {
  const input = await parent(mode, author);
  const before = await nats.store.head();
  await expect(requestChild(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
}
it.each([['group', 'bob'], ['direct', 'alice'], ['agent_session', 'alice']])(
  'refuses %s parent or %s source without appending', refusesSource);
async function refusesChoices(patch: object) {
  const input = { ...await parent(), ...patch };
  const before = await nats.store.head();
  await expect(requestChild(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
}
it.each([{ participantIds: ['bob'] }, { participantIds: ['alice', 'unknown'] },
  { participantIds: Array(98).fill('alice') }, { payingGroupId: 'owners' },
  { sourceMessageId: 'guessed' }, { conversationId: 'guessed' },
  { assistantId: 'guessed' }, { allowanceBoundCents: 1001 }])(
  'refuses invalid review %j', refusesChoices);
async function refusesChangedAccess(kind: string) {
  const input = await parent();
  if (kind === 'closed') {
    await save(`participation-${input.conversationId}`, 'conversation.closed',
      { conversationId: input.conversationId, closedBy: 'alice' });
  } else {
    await save(`participation-${input.conversationId}`, 'participant.removed',
      { conversationId: input.conversationId, participantId: 'alice', removedBy: 'alice' });
    await save(`participation-${input.conversationId}`, 'participant.added',
      { conversationId: input.conversationId, participantId: 'alice', addedBy: 'bob' });
  }
  const before = await nats.store.head();
  await expect(requestChild(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
}
it.each(['closed', 'rejoined'])('refuses a %s parent', refusesChangedAccess);
async function savesAndReplays() {
  const input = await parent('group', 'alice', true);
  const initial = await chatHistory(nats.store, 'test', input.conversationId);
  expect(initial).toHaveLength(2);
  const head = vi.spyOn(nats.store, 'head');
  const reads = vi.spyOn(nats.store, 'readStream');
  const reviewed = await reviewChildRequest(options, 'alice', input);
  expect(reviewed.allowanceBoundCents).toBe(1000);
  async function request() {
    return requestChild(options, 'alice', input);
  }
  await loseReply(request);
  const intent = await request();
  expect(intent.event.data).toEqual(reviewed);
  for (const [subject] of head.mock.calls) {
    if (subject) expect(subject).toMatch(/^(member|participation|assistant|team)-/u);
  }
  const firstRead = reads.mock.calls[0]!;
  expect(firstRead[0]).toBe(`conversation-${input.conversationId}`);
  expect(firstRead[2]).toBeGreaterThan(performance.now() + 5000);
  head.mockRestore();
  reads.mockRestore();
  for (const patch of [{ participantIds: ['alice'] }, { assistantId: 'other' },
    { payingGroupId: 'owners' }, { allowanceBoundCents: 999 }]) {
    await expect(requestChild(options, 'alice', { ...input, ...patch })).rejects.toThrow();
  }
  async function create() {
    return createRequestedChild(options, 'alice', input);
  }
  await loseReply(create);
  await delay(120_100);
  const positionAfterLoss = await nats.store.head();
  const source = { id: input.sourceMessageId, conversationId: input.conversationId,
    text: '@Assistant source canary' };
  await chatCommand(nats.store, conversationKeys(directory),
    { silo: 'test', memberId: 'alice' }, source);
  expect(await nats.store.head()).toBe(positionAfterLoss);
  const retry = await requestChild(options, 'alice', { ...input, requestId: 'another-request' });
  expect(retry).toEqual(intent);
  const child = await createRequestedChild(options, 'alice', input);
  expect(await createRequestedChild(options, 'alice', input)).toEqual(child);
  expect(child.event.data).toMatchObject({ initialJoins: reviewed.initialJoins,
    origin: { intentEventId: intent.event.id, intentPosition: intent.sequence,
      firstInputId: reviewed.firstInputId, requestId: input.requestId } });
  await auth.handler.handle(child.event, options.db);
  await runner.run(conversations);
  const before = await readConversation(options.db, 'test', input.conversationId);
  expect(before.rows).toHaveLength(2);
  const position = await nats.store.head();
  await runner.rebuild(conversations);
  expect((await readConversation(options.db, 'test', input.conversationId)).rows).toEqual(before.rows);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader,
    { verifyAgainst: options.binding });
  expect(rebuilt.verified).toBe(true);
  expect(await nats.store.head()).toBe(position);
  const childRows = await chatHistory(nats.store, 'test', reviewed.childConversationId);
  expect(childRows).toHaveLength(1);
}
it('freezes one intent and child across lost replies, expired deduplication and replay',
  savesAndReplays, 180_000);

async function refusesMembership(teamId: string) {
  const input = await parent();
  await save(`team-${teamId}`, 'team.member_removed',
    { teamId, memberId: 'alice', removedBy: 'alice' });
  const before = await nats.store.head();
  await expect(requestChild(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
  await save(`team-${teamId}`, 'team.member_added',
    { teamId, memberId: 'alice', addedBy: 'alice' });
}
it.each(['owners', 'payer'])('refuses missing %s membership', refusesMembership);
async function keepsFrozenAudience() {
  const input = await parent();
  const intent = await requestChild(options, 'alice', input);
  await save(`participation-${input.conversationId}`, 'participant.removed',
    { conversationId: input.conversationId, participantId: 'bob', removedBy: 'alice' });
  const before = await nats.store.head();
  await expect(reviewChildRequest(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
  const child = await createRequestedChild(options, 'alice', input);
  const recorded = childRequestedDataSchema.parse(intent.event.data);
  expect(child.event.data).toMatchObject({ initialJoins: recorded.initialJoins });
  await save('member-bob', 'member.removed', { memberId: 'bob', removedBy: 'alice', reason: 'left' });
  await refusesChoices({});
}
it('never substitutes people for a removed audience member and refuses inactive people',
  keepsFrozenAudience);

async function loseReply(action: () => Promise<unknown>) {
  const original = nats.store.append.bind(nats.store);
  const append = vi.spyOn(nats.store, 'append');
  async function losesReply(command: Parameters<typeof original>[0]): Promise<never> {
    await original(command);
    throw new Error('Lost reply');
  }
  append.mockImplementationOnce(losesReply);
  try {
    await expect(action()).rejects.toThrow('Lost reply');
  } finally {
    append.mockRestore();
  }
}
async function parentReaders(conversationId: string) {
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const feed = await connectMemberFeed(storage.queue.options.connectionString!);
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const chat = { ...options, keys: conversationKeys(directory), feed: { memberId } };
  const app = buildServer(config, { chat });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed, binding: options.binding, chat };
  const wss = attachWebSocketServer(app.server, app.log, config, realtime);
  try {
    for (const sub of ['alice', 'carol']) {
      const session = { sub, orgId: 'org-test', roles: [], authTime: 1790856000, exp: 2000000000 };
      const headers = { origin: 'https://app.example.test',
        cookie: `${config.cookieName}=${encodeSession(config, session)}` };
      const response = await app.inject({ method: 'GET',
        url: `/api/conversations/${conversationId}/messages`, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toMatch(/child_requested|initialJoins|allowanceBoundCents/u);
      const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
      const received: string[] = [];
      function receive(raw: Buffer) {
        received.push(raw.toString());
      }
      socket.on('message', receive);
      try {
        await once(socket, 'open');
        socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation',
          conversationId, since: 0 }));
        function ready() {
          const frames = received.join('');
          return frames.includes('"type":"ready"');
        }
        await until(ready);
        expect(received.join('')).not.toMatch(/child_requested|initialJoins|allowanceBoundCents/u);
      } finally {
        socket.terminate();
      }
      const before = await nats.store.head();
      const payload = { id: `literal-${sub}`, text: '@Assistant' };
      const posted = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`,
        headers, payload });
      expect(posted.statusCode, posted.body).toBe(200);
      expect(await nats.store.head()).toBe(before + 1);
    }
  } finally {
    wss.close();
    await app.close();
    await feed.close();
  }
}

async function refusesForeignAndMissingPermission() {
  const input = await parent();
  const foreign = { ...options, silo: 'foreign' };
  const before = await nats.store.head();
  await expect(requestChild(foreign, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
  const data = { assistantId: 'without-permission', ownerId: 'owners', kind: 'team',
    payingGroupId: 'payer' };
  const assistant = await save('assistant-without-permission', 'assistant.created', data, false);
  const wrongPermission = { ...assistant, data: { ...data, ownerId: 'unknown' } };
  await auth.handler.handle(wrongPermission, options.db);
  const position = await nats.store.head();
  const request = { ...input, assistantId: 'without-permission', participantIds: ['alice'] };
  await expect(requestChild(options, 'alice', request)).rejects.toThrow();
  expect(await nats.store.head()).toBe(position);
}
it('refuses a foreign silo and missing assistant permission', refusesForeignAndMissingPermission);

async function readsParentHistory() {
  const input = await parent();
  input.participantIds = ['alice'];
  await requestChild(options, 'alice', input);
  await runner.run(conversations);
  await parentReaders(input.conversationId);
}
it('keeps parent HTTP and socket history readable and literal mentions inert', readsParentHistory);
