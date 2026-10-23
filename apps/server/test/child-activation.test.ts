import { z } from 'zod';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { until } from '@opencrane/authz/testing';
import { attachWebSocketServer } from '../src/websocket.ts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as authz from '@opencrane/authz';
import { createEventStore, type StoredEvent } from '@opencrane/event-store';
import { childRequestedDataSchema } from '@opencrane/events';
import { conversations } from '@opencrane/projections';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { addChildFirstInput, createRequestedChild, requestChild, retryChildRequest }
  from '../src/chat/child-requests.ts';
import { recordChildStartFailure } from '../src/chat/child-failure.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { summonFixture } from './support/child-summon.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';

const eventData = z.record(z.string(), z.unknown());
let context: Awaited<ReturnType<typeof summonFixture>>;
async function initialise() {
  const nats = await shortDuplicateWindowFixture();
  context = await summonFixture(nats);
}
async function close() {
  await context?.close();
}
beforeAll(initialise, 60_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
async function prepare(stage = 'complete') {
  const input = { ...await context.parent(), payingGroupId: 'payer' };
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  let creation: StoredEvent | undefined;
  if (stage !== 'missing creation') {
    creation = await createRequestedChild(context.options, 'alice', input);
    if (stage !== 'unapplied') await context.auth.handler.handle(creation.event, context.db);
  }
  if (stage === 'complete') await addChildFirstInput(context.options, 'alice', input);
  return { input, intent, data, creation };
}
async function savesOnce() {
  const saved = await prepare();
  const before = await context.nats.store.head();
  const provision = vi.spyOn(context.keys, 'provision');
  const encrypted = vi.spyOn(context.keys, 'encrypt');
  const heads = vi.spyOn(context.nats.store, 'head');
  const reads = vi.spyOn(context.nats.store, 'readStream');
  const activated = await activateRequestedChild(context.options, 'alice', saved.input, 1);
  expect(activated.event).toMatchObject({ type: 'conversation.child_activated',
    subject: `conversation-${saved.data.childConversationId}`,
    data: { intentEventId: saved.intent.event.id, intentPosition: saved.intent.sequence,
      creationEventId: saved.creation!.event.id, creationPosition: saved.creation!.sequence,
      firstInputId: saved.data.firstInputId, requestedBy: 'alice', attempt: 1,
      assistantId: 'helper', payingGroupId: 'payer' } });
  expect(activated.sequence).toBe(before + 1);
  for (const conversationId of [saved.input.conversationId, saved.data.childConversationId]) {
    function matches(call: unknown[]) {
      return call[0] === `conversation-${conversationId}`;
    }
    const index = reads.mock.calls.findIndex(matches);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(reads.mock.invocationCallOrder[index]).toBeLessThan(heads.mock.invocationCallOrder[0]!);
  }
  for (const [subject] of heads.mock.calls) {
    if (subject) expect(subject).not.toMatch(/^conversation-/u);
  }
  expect(provision).not.toHaveBeenCalled();
  expect(encrypted).not.toHaveBeenCalled();
  await waitForDuplicateWindow(context.nats);
  const head = await context.nats.store.head();
  const connection = await context.nats.client('command');
  const store = await createEventStore(connection);
  expect(await activateRequestedChild({ ...context.options, store }, 'alice', saved.input, 1))
    .toEqual(activated);
  await context.runner.rebuild(conversations);
  expect(await context.nats.store.head()).toBe(head);
  const response = await context.request(saved.data.childConversationId, 'messages');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).toContain('message.posted');
  expect(response.body).not.toContain('child_activated');
  expect(response.body).not.toContain(activated.event.id);
  await socketMessages(saved.data.childConversationId);
}
it('saves one exact activation and recovers it after expiry and projection replay', savesOnce);
async function lostReply() {
  const saved = await prepare();
  const append = context.nats.store.append.bind(context.nats.store);
  async function lose(command: Parameters<typeof append>[0]): Promise<never> {
    await append(command);
    throw new Error('Lost reply');
  }
  const fault = vi.spyOn(context.nats.store, 'append').mockImplementationOnce(lose);
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1))
    .rejects.toThrow('Lost reply');
  fault.mockRestore();
  await waitForDuplicateWindow(context.nats);
  const before = await context.nats.store.head();
  const rows = await chatHistory(context.nats.store, 'test', saved.data.childConversationId);
  expect(await activateRequestedChild(context.options, 'alice', saved.input, 1)).toEqual(rows.at(-1));
  expect(await context.nats.store.head()).toBe(before);
}
it('recovers a lost activation reply beyond broker deduplication', lostReply);
async function refusesMissing(stage: string) {
  const saved = await prepare(stage);
  const before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['missing creation', 'unapplied', 'absent input'])(
  'does not activate with %s', refusesMissing);
async function refusesChanged(patch: object) {
  const saved = await prepare();
  const before = await context.nats.store.head();
  const input = { ...saved.input, ...patch };
  await expect(activateRequestedChild(context.options, 'alice', input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
it.each([{ requestId: 'other' }, { sourceMessageId: 'other' }, { payingGroupId: 'other' },
  { assistantId: 'other-helper' }, { participantIds: ['alice'] }])(
  'refuses changed saved choices %j', refusesChanged);
async function refusesAttempt() {
  const saved = await prepare();
  await recordChildStartFailure(context.options, saved.intent.event.id, saved.data,
    'first_input', 'access_refused');
  let before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
  const rows = await chatHistory(context.nats.store, 'test', saved.input.conversationId);
  const retry = { retryId: 'retry', failureEventId: rows.at(-1)!.event.id };
  await retryChildRequest(context.options, 'alice', saved.input.conversationId,
    saved.input.requestId, retry);
  before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
  const activated = await activateRequestedChild(context.options, 'alice', saved.input, 2);
  expect(activated.event.data).toMatchObject({ attempt: 2 });
}
it('refuses failed and superseded attempts while permitting the current retry', refusesAttempt);
async function refusesStoredChange(kind: string) {
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* changed(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      let altered = row.event;
      if (row.event.id === saved.data.firstInputId) {
        if (kind === 'author') altered = { ...altered, principal: { kind: 'human', id: 'bob' } };
        if (kind === 'silo') altered = { ...altered, silo: 'foreign' };
        if (kind === 'input') {
          const encrypted = context.keys.encrypt('test', saved.data.childConversationId, 'changed');
          altered = { ...altered, data: { ...eventData.parse(row.event.data), ...encrypted } };
        }
      }
      if (row.event.id === saved.input.sourceMessageId && kind === 'source author') {
        altered = { ...altered, principal: { kind: 'human', id: 'bob' } };
      }
      if (row.event.id === saved.creation!.event.id && kind === 'creation') {
        altered = { ...altered, data: { ...eventData.parse(row.event.data), payingGroupId: 'other' } };
      }
      yield { ...row, event: altered };
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(changed);
  const before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['author', 'silo', 'input', 'creation', 'source author'])(
  'refuses changed stored %s', refusesStoredChange);

async function refusesAccess(kind: string, racing: boolean) {
  const saved = await prepare();
  async function revoke() {
    const child = saved.data.childConversationId;
    const parent = saved.input.conversationId;
    if (kind.endsWith('closed')) {
      const conversationId = kind === 'parent closed' ? parent : child;
      await context.append(`participation-${conversationId}`, 'conversation.closed',
        { conversationId, closedBy: 'alice' }, false);
    } else if (kind === 'silo') {
      await context.append('member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'bob', reason: 'left' });
    } else if (kind === 'parent removed' || kind === 'child removed') {
      const conversationId = kind === 'parent removed' ? parent : child;
      await context.append(`participation-${conversationId}`, 'participant.removed',
        { conversationId, participantId: 'alice', removedBy: 'bob' }, false);
    } else {
      await context.append(`team-${kind}`, 'team.member_removed',
        { teamId: kind, memberId: 'alice', removedBy: 'bob' });
    }
  }
  if (!racing) await revoke();
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* changeBeforeAppend(...args: Parameters<typeof read>) {
    if (args[0] === `conversation-${saved.input.conversationId}` && args[1]! > 1) await revoke();
    yield* read(...args);
  }
  if (racing) vi.spyOn(context.nats.store, 'readStream').mockImplementation(changeBeforeAppend);
  const appends = vi.spyOn(context.nats.store, 'append');
  try {
    await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
    expect(appends).not.toHaveBeenCalled();
  } finally {
    if (kind === 'silo') {
      await context.append('member-alice', 'member.joined',
        { memberId: 'alice', role: 'member', email: 'alice@example.test', displayName: 'Alice' });
    }
    if (kind === 'payer' || kind === 'owners') {
      await context.append(`team-${kind}`, 'team.member_added',
        { teamId: kind, memberId: 'alice', addedBy: 'alice' });
    }
  }
}
async function revoked(kind: string) {
  await refusesAccess(kind, false);
}
it.each(['parent closed', 'child closed', 'parent removed', 'child removed', 'payer', 'owners', 'silo'])(
  'refuses revoked %s before checking', revoked);
async function racing(kind: string) {
  await refusesAccess(kind, true);
}
it.each(['parent closed', 'child closed', 'parent removed', 'child removed'])(
  'refuses %s racing the append', racing);
async function uncertain(kind: string) {
  const saved = await prepare();
  const original = authz.memberAuthorisation;
  function unavailable() {
    return Promise.resolve({ allowed: false as const, status: 'unavailable' as const,
      error: new Error('Unavailable') });
  }
  function changed(...args: Parameters<typeof original>) {
    return { ...original(...args), actsFor: unavailable };
  }
  function broken(): never {
    throw new Error('Unavailable');
  }
  let fault;
  if (kind === 'IAM') fault = vi.spyOn(authz, 'memberAuthorisation').mockImplementation(changed);
  else fault = vi.spyOn(context.keys, 'decrypt').mockImplementation(broken);
  const before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
  fault.mockRestore();
  expect((await activateRequestedChild(context.options, 'alice', saved.input, 1)).event.type)
    .toBe('conversation.child_activated');
}
it.each(['IAM', 'storage'])('keeps %s uncertainty retryable', uncertain);
async function keepsDeadline() {
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  let originalDeadline = 0;
  async function* expired(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === `conversation-${saved.input.conversationId}` && args[1]! > 1) {
      originalDeadline = args[2]!;
      vi.spyOn(performance, 'now').mockReturnValue(originalDeadline + 1);
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(expired);
  const appends = vi.spyOn(context.nats.store, 'append');
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1))
    .rejects.toThrow('Authority snapshot expired');
  expect(originalDeadline).toBeGreaterThan(0);
  expect(appends).not.toHaveBeenCalled();
}
it('retains the original write deadline after checking the parent attempt', keepsDeadline);
async function twoWorkers() {
  const saved = await prepare();
  const connection = await context.nats.client('command');
  const store = await createEventStore(connection);
  const other = { ...context.options, store };
  const ready = Promise.withResolvers<void>();
  let waiting = 0;
  function paused(original: typeof store.append) {
    return async function append(command: Parameters<typeof original>[0]) {
      waiting++;
      if (waiting === 2) ready.resolve();
      await ready.promise;
      return original(command);
    };
  }
  const firstAppend = paused(context.nats.store.append.bind(context.nats.store));
  const secondAppend = paused(store.append.bind(store));
  vi.spyOn(context.nats.store, 'append').mockImplementation(firstAppend);
  vi.spyOn(store, 'append').mockImplementation(secondAppend);
  const results = await Promise.all([
    activateRequestedChild(context.options, 'alice', saved.input, 1),
    activateRequestedChild(other, 'alice', saved.input, 1),
  ]);
  expect(results[0]).toEqual(results[1]);
  vi.restoreAllMocks();
  const before = await store.head();
  const changed = { ...saved.input, payingGroupId: 'owners' };
  await expect(activateRequestedChild(other, 'alice', changed, 1)).rejects.toThrow();
  expect(await store.head()).toBe(before);
}
it('allows two workers to recover only one identical binding', twoWorkers);

async function socketMessages(conversationId: string) {
  const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed: context.feed, binding: context.options.binding, chat: context.options };
  const server = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`,
    { headers: context.headers() });
  const frames: string[] = [];
  function receive(raw: Buffer) {
    frames.push(raw.toString());
  }
  function ready() {
    return frames.join('').includes('"type":"ready"');
  }
  socket.on('message', receive);
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId, since: 0 }));
    await until(ready);
    expect(frames.join('')).toContain('message.posted');
    expect(frames.join('')).not.toContain('child_activated');
  } finally {
    socket.terminate();
    server.close();
  }
}

async function refusesChangedActivation(field: string) {
  const saved = await prepare();
  const activation = await activateRequestedChild(context.options, 'alice', saved.input, 1);
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* altered(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (row.event.id !== activation.event.id) yield row;
      else {
        const data = { ...eventData.parse(row.event.data), [field]: 'changed' };
        yield { ...row, event: { ...row.event, data } };
      }
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(altered);
  const before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['intentEventId', 'firstInputId', 'attempt', 'payingGroupId'])(
  'refuses an existing activation with changed %s', refusesChangedActivation);

async function failureDuringCheck() {
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* fails(...args: Parameters<typeof read>) {
    if (args[0] === `conversation-${saved.input.conversationId}` && args[1]! > 1) {
      await recordChildStartFailure(context.options, saved.intent.event.id, saved.data,
        'first_input', 'access_refused');
    }
    yield* read(...args);
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(fails);
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  const rows = await chatHistory(context.nats.store, 'test', saved.data.childConversationId);
  expect(rows).toHaveLength(2);
}
it('refuses a failure saved after loading history and before the append', failureDuringCheck);
