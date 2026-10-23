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
import { shortenDuplicateWindow, waitForDuplicateWindow } from './support/duplicate-window.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
async function initialise() {
  context = await summonFixture();
  await shortenDuplicateWindow(context.nats);
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
  const activated = await activateRequestedChild(context.options, 'alice', saved.input, 1);
  expect(activated.event).toMatchObject({ type: 'conversation.child_activated',
    subject: `conversation-${saved.data.childConversationId}`,
    data: { intentEventId: saved.intent.event.id, intentPosition: saved.intent.sequence,
      creationEventId: saved.creation!.event.id, creationPosition: saved.creation!.sequence,
      firstInputId: saved.data.firstInputId, requestedBy: 'alice', attempt: 1,
      assistantId: 'helper', payingGroupId: 'payer' } });
  expect(activated.sequence).toBe(before + 1);
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
          altered = { ...altered, data: { ...row.event.data as object, ...encrypted } };
        }
      }
      if (row.event.id === saved.creation!.event.id && kind === 'creation') {
        altered = { ...altered, data: { ...row.event.data as object, payingGroupId: 'other' } };
      }
      yield { ...row, event: altered };
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(changed);
  const before = await context.nats.store.head();
  await expect(activateRequestedChild(context.options, 'alice', saved.input, 1)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['author', 'silo', 'input', 'creation'])(
  'refuses changed stored %s', refusesStoredChange);
