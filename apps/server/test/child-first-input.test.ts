import { shortenDuplicateWindow, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { conversationKeys, conversations, computers, pgDb, ProjectionRunner }
  from '@opencrane/projections';
import { childRequestedDataSchema, conversationCreatedDataSchema, eventEnvelopeSchema } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { addChildFirstInput, createRequestedChild, requestChild }
  from '../src/chat/child-requests.ts';
import { chatHistory, ChatConflict } from '../src/chat/commands.ts';
import { ParticipationApplying } from '../src/chat/participation.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let options: Parameters<typeof addChildFirstInput>[0];
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let directory: string;
let counter = 0;
const creationSchema = eventEnvelopeSchema(conversationCreatedDataSchema);
const sourceText = '  Reviewed **source**\nwith exact spacing.  ';
async function append(saved: StoredEvent['event'], apply = true) {
  const command = { event: saved, expectedSequence: await nats.store.head(saved.subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(saved.type)) {
    await auth.handler.handle(saved, options.db);
  }
  return saved;
}
async function save(subject: string, type: string, data: unknown, apply = true) {
  const saved = { ...event(`fixture-${++counter}`, subject, type), data };
  return append(saved, apply);
}
async function initialise() {
  nats = await natsFixture();
  storage = await databases();
  fga = await openfga();
  directory = await mkdtemp(`${tmpdir()}/child-first-input-`);
  const db = pgDb(storage.queue);
  const binding = await createStore(fga.apiUrl, 'test');
  options = { silo: 'test', store: nats.store, db, binding, keys: conversationKeys(directory) };
  auth = memberAuthorisation(binding, nats.store);
  runner = new ProjectionRunner(db, nats.reader, createLogger('child-input-test'));
  await runner.initialise(computers);
  await runner.initialise(conversations);
  for (const memberId of ['alice', 'bob']) {
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
afterEach(vi.restoreAllMocks);
async function post(conversationId: string, authorId: string, text: string) {
  const encrypted = options.keys.encrypt('test', conversationId, text);
  const data = { conversationId, authorId, authorKind: 'human', contentType: 'markdown',
    ...encrypted };
  const saved = { ...event(`message-${++counter}`, `conversation-${conversationId}`, 'message.posted'),
    principal: { kind: 'human' as const, id: authorId }, data };
  return append(saved);
}
async function prepare(create = true) {
  const conversationId = `parent-${++counter}`;
  await save(`conversation-${conversationId}`, 'conversation.created',
    { conversationId, createdBy: 'alice', mode: 'group', participantIds: ['alice', 'bob'] });
  options.keys.provision('test', conversationId);
  for (const author of ['alice', 'bob']) await post(conversationId, author, `${author} BEFORE canary`);
  const source = await post(conversationId, 'alice', sourceText);
  for (const author of ['alice', 'bob']) await post(conversationId, author, `${author} AFTER canary`);
  const input = { conversationId, sourceMessageId: source.id, requestId: `request-${counter}`,
    assistantId: 'assistant', payingGroupId: 'payer', participantIds: ['alice', 'bob'] };
  const intent = await requestChild(options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  let creation: StoredEvent | undefined;
  if (create) creation = await createRequestedChild(options, 'alice', input);
  return { input, data, creation };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function applyCreation(prepared: Prepared) {
  await auth.handler.handle(prepared.creation!.event, options.db);
}
async function copiesAfterReceipt() {
  const prepared = await prepare();
  const { input, data, creation } = prepared;
  const parentBefore = await chatHistory(nats.store, 'test', input.conversationId);
  const before = await nats.store.head();
  await expect(addChildFirstInput(options, 'alice', input)).rejects.toThrow(ParticipationApplying);
  expect(await nats.store.head()).toBe(before);
  await applyCreation(prepared);
  const heads = vi.spyOn(nats.store, 'head');
  const reads = vi.spyOn(nats.store, 'readStream');
  const appends = vi.spyOn(nats.store, 'append');
  const first = await addChildFirstInput(options, 'alice', input);
  expect(appends).toHaveBeenCalledTimes(1);
  expect(appends.mock.calls[0]![0]).toMatchObject({ expectedSequence: creation!.sequence,
    event: { type: 'message.posted' } });
  const firstHead = heads.mock.invocationCallOrder[0]!;
  const subjects = [`conversation-${input.conversationId}`, `conversation-${data.childConversationId}`];
  for (const subject of subjects) {
    function matchesSubject(call: unknown[]) {
      return call[0] === subject;
    }
    const index = reads.mock.calls.findIndex(matchesSubject);
    expect(reads.mock.invocationCallOrder[index]).toBeLessThan(firstHead);
    expect(reads.mock.calls[index]![2]).toBeGreaterThan(performance.now() + 5000);
  }
  const watched = new Set<string>();
  for (const [subject] of heads.mock.calls) {
    if (subject) watched.add(subject);
  }
  expect(watched).toEqual(new Set(['member-alice', 'assistant-assistant', 'team-owners',
    'team-payer', `participation-${input.conversationId}`, `participation-${data.childConversationId}`]));
  expect(first.event).toMatchObject({ id: data.firstInputId, commandId: data.firstInputId,
    source: 'opencrane-server', principal: { kind: 'human', id: 'alice' },
    data: { authorId: 'alice', authorKind: 'human', contentType: 'markdown' } });
  expect(first.event.data).not.toHaveProperty('executionMode');
  expect(options.keys.decrypt('test', data.childConversationId, first.event.data)).toBe(sourceText);
  expect(await chatHistory(nats.store, 'test', data.childConversationId)).toEqual([creation, first]);
  expect(await chatHistory(nats.store, 'test', input.conversationId)).toEqual(parentBefore);
  expect(JSON.stringify(first)).not.toMatch(/canary|Reviewed/u);
  appends.mockClear();
  await runner.rebuild(conversations);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader,
    { verifyAgainst: options.binding });
  expect(rebuilt.verified).toBe(true);
  expect(appends).not.toHaveBeenCalled();
}

it('copies only the exact source after the receipt, with short access checks and quiet rebuilds',
  copiesAfterReceipt);

async function refusesChangedState(kind: string) {
  const prepared = await prepare(kind !== 'no child');
  const { input, data } = prepared;
  let removal: StoredEvent['event'] | undefined;
  if (prepared.creation) await applyCreation(prepared);
  if (kind === 'parent closed' || kind === 'child closed') {
    let conversationId = input.conversationId;
    if (kind === 'child closed') conversationId = data.childConversationId;
    await save(`participation-${conversationId}`, 'conversation.closed',
      { conversationId, closedBy: 'alice' }, false);
  }
  if (kind === 'removed' || kind === 'rejoined') {
    await save(`participation-${input.conversationId}`, 'participant.removed',
      { conversationId: input.conversationId, participantId: 'alice', removedBy: 'bob' }, false);
    if (kind === 'rejoined') {
      await save(`participation-${input.conversationId}`, 'participant.added',
        { conversationId: input.conversationId, participantId: 'alice', addedBy: 'bob' });
    }
  }
  if (kind === 'silo removed') {
    removal = await save('member-alice', 'member.removed',
      { memberId: 'alice', removedBy: 'bob', reason: 'left' }, false);
  }
  if (kind === 'later entry') {
    options.keys.provision('test', data.childConversationId);
    await post(data.childConversationId, 'alice', 'unrelated input');
  }
  const before = await nats.store.head();
  await expect(addChildFirstInput(options, 'alice', input)).rejects.toThrow();
  expect(await nats.store.head()).toBe(before);
  if (kind === 'silo removed') {
    await auth.handler.handle(removal!, options.db);
    await save('member-alice', 'member.joined', { memberId: 'alice', role: 'member',
      email: 'alice@example.test', displayName: 'Alice' });
  }
}
it.each(['no child', 'parent closed', 'child closed', 'removed', 'rejoined',
  'silo removed', 'later entry'])('refuses %s without appending', refusesChangedState);
async function refusesChoices(patch: object) {
  const prepared = await prepare();
  await applyCreation(prepared);
  const before = await nats.store.head();
  const input = { ...prepared.input, ...patch };
  await expect(addChildFirstInput(options, 'alice', input)).rejects.toThrow(ChatConflict);
  expect(await nats.store.head()).toBe(before);
}
it.each([{ assistantId: 'other' }, { payingGroupId: 'other' },
  { participantIds: ['alice'] }, { allowanceBoundCents: 999 }])(
  'refuses changed reviewed choices %j', refusesChoices);

async function retriesLostReply() {
  const previous = { nats, storage, fga, options, auth, runner, directory };
  await initialise();
  try {
    await shortenDuplicateWindow(nats);
    await retriesLostReplyAfterExpiry();
  } finally {
    vi.restoreAllMocks();
    await close();
    ({ nats, storage, fga, options, auth, runner, directory } = previous);
  }
}
async function retriesLostReplyAfterExpiry() {
  const prepared = await prepare();
  await applyCreation(prepared);
  const original = nats.store.append.bind(nats.store);
  async function losesReply(command: Parameters<typeof original>[0]): Promise<never> {
    await original(command);
    throw new Error('Lost reply');
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementationOnce(losesReply);
  await expect(addChildFirstInput(options, 'alice', prepared.input)).rejects.toThrow('Lost reply');
  appendSpy.mockRestore();
  const rows = await chatHistory(nats.store, 'test', prepared.data.childConversationId);
  await waitForDuplicateWindow(nats);
  const retry = { ...prepared.input, requestId: 'another-request' };
  expect(await addChildFirstInput(options, 'alice', retry)).toEqual(rows[1]);
  expect(await chatHistory(nats.store, 'test', prepared.data.childConversationId)).toEqual(rows);
}
it('returns the saved id, position and ciphertext after a lost reply beyond deduplication',
  retriesLostReply);
async function concurrentCalls() {
  const prepared = await prepare();
  await applyCreation(prepared);
  const append = nats.store.append.bind(nats.store);
  let release!: () => void;
  const bothReady = new Promise<void>(ready);
  function ready(resolve: () => void) {
    release = resolve;
  }
  let calls = 0;
  async function together(command: Parameters<typeof append>[0]) {
    calls += 1;
    if (calls === 2) release();
    await bothReady;
    return append(command);
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementation(together);
  const results = await Promise.all([addChildFirstInput(options, 'alice', prepared.input),
    addChildFirstInput(options, 'alice', prepared.input)]);
  expect(results[0]).toEqual(results[1]);
  expect(spy).toHaveBeenCalledTimes(2);
  for (const [command] of spy.mock.calls) {
    expect(command.event).toMatchObject({ type: 'message.posted' });
  }
  spy.mockRestore();
  expect(await chatHistory(nats.store, 'test', prepared.data.childConversationId))
    .toEqual([prepared.creation, results[0]]);
}
it('returns one identical saved input to two concurrent calls', concurrentCalls);

async function refusesDifferentInput(patch: string) {
  const prepared = await prepare();
  const { data, input } = prepared;
  await applyCreation(prepared);
  options.keys.provision('test', data.childConversationId);
  let text = sourceText;
  if (patch === 'text') text = 'a different message';
  const encrypted = options.keys.encrypt('test', data.childConversationId, text);
  let payload: object = { conversationId: data.childConversationId, authorId: 'alice',
    authorKind: 'human', contentType: 'markdown', ...encrypted };
  if (patch === 'authorId') payload = { ...payload, authorId: 'bob' };
  if (patch === 'authorKind') payload = { ...payload, authorKind: 'agent' };
  if (patch === 'contentType') payload = { ...payload, contentType: 'text' };
  if (patch === 'executionMode') payload = { ...payload, executionMode: 'memory_free' };
  if (patch === 'keyId') payload = { ...payload, keyId: 'key:other' };
  if (patch === 'ciphertext') payload = { ...payload, ciphertext: 'bm90LWNpcGhlcnRleHQ=' };
  const saved = { ...event(data.firstInputId, `conversation-${data.childConversationId}`,
    'message.posted'), commandId: data.firstInputId,
    principal: { kind: 'human' as const, id: 'alice' }, data: payload };
  if (patch === 'commandId') saved.commandId = 'another-command';
  if (patch === 'principal') saved.principal.id = 'bob';
  if (patch === 'source') saved.source = 'other-server';
  if (patch === 'correlation') saved.correlation = { request: 'unexpected' };
  if (patch === 'type') {
    saved.type = 'agent.turn_stop_requested';
    saved.data = { conversationId: data.childConversationId, turnId: 'turn', requestedBy: 'alice' };
  }
  await append(saved, false);
  const before = await nats.store.head();
  await expect(addChildFirstInput(options, 'alice', input)).rejects.toThrow(ChatConflict);
  expect(await nats.store.head()).toBe(before);
}
it.each(['text', 'authorId', 'authorKind', 'contentType', 'executionMode', 'keyId',
  'ciphertext', 'commandId', 'principal', 'source', 'correlation', 'type'])(
  'refuses an existing input with different %s', refusesDifferentInput);

async function refusesChangedCreation(field: string) {
  const prepared = await prepare(false);
  const original = nats.store.append.bind(nats.store);
  async function changeOrigin(command: Parameters<typeof original>[0]) {
    const saved = creationSchema.parse(command.event);
    const data = saved.data;
    if (!('contextKind' in data)) throw new Error('Shared child required');
    const changedData = { ...data };
    if (field === 'firstInputId') {
      changedData.origin = { ...data.origin, firstInputId: 'different-input' };
    }
    if (field === 'assistant') changedData.assistantId = 'other';
    if (field === 'payer') changedData.payingGroupId = 'other';
    if (field === 'audience') changedData.initialJoins = [data.initialJoins[0]!];
    if (field === 'intent') {
      changedData.origin = { ...data.origin, intentEventId: 'other-intent' };
    }
    const changed = { ...saved, data: changedData };
    const changedCommand = { ...command, event: changed };
    return original(changedCommand);
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(changeOrigin);
  await expect(createRequestedChild(options, 'alice', prepared.input)).rejects.toThrow(ChatConflict);
  spy.mockRestore();
  const rows = await chatHistory(nats.store, 'test', prepared.data.childConversationId);
  await auth.handler.handle(rows[0]!.event, options.db);
  const before = await nats.store.head();
  await expect(addChildFirstInput(options, 'alice', prepared.input)).rejects.toThrow(ChatConflict);
  expect(await nats.store.head()).toBe(before);
}
it.each(['firstInputId', 'assistant', 'payer', 'audience', 'intent'])(
  'refuses a saved creation with different %s from the intent', refusesChangedCreation);
