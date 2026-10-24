import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../src/server.ts';
import { createEventStore } from '@opencrane/event-store';
import * as authz from '@opencrane/authz';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { recoverChildRequest } from '../src/chat/child-recovery.ts';
import { childRequestHeld } from '../src/chat/child-hold.ts';
import { childRequests, conversations } from '@opencrane/projections';
import { requestChild, createRequestedChild, retryChildRequest, ChildRequestChanged }
  from '../src/chat/child-requests.ts';
import { recordChildStartFailure } from '../src/chat/child-failure.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
async function setup() {
  const nats = await shortDuplicateWindowFixture();
  context = await summonFixture(nats);
  await context.runner.initialise(childRequests);
}
async function cleanup() {
  await context.close();
}
beforeAll(setup, 60_000);
afterAll(cleanup);
afterEach(vi.restoreAllMocks);

async function failedRequest(created = false, failed = true) {
  const input = await context.parent();
  const command = { ...input, payingGroupId: 'payer' };
  const saved = await requestChild(context.options, 'alice', command);
  if (created) {
    const child = await createRequestedChild(context.options, 'alice', command);
    await context.auth.handler.handle(child.event, context.db);
  }
  const intent = await context.intent(input.conversationId);
  const stage = created ? 'first_input' : 'create';
  if (failed) {
    await recordChildStartFailure(context.options, saved.event.id, intent, stage, 'access_refused');
  }
  const rows = await chatHistory(context.nats.store, 'test', input.conversationId);
  const failureEventId = rows.at(-1)!.event.id;
  const payload = { retryId: `retry-${input.requestId}`, failureEventId };
  const path = `children/${input.requestId}/retry`;
  return { input, intent, saved, payload, path };
}
async function acceptsSavedFailure() {
  const request = await failedRequest();
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json()).toMatchObject({ requestId: request.input.requestId,
    retryId: request.payload.retryId, failureEventId: request.payload.failureEventId, attempt: 2 });
  const rows = await chatHistory(context.nats.store, 'test', request.input.conversationId);
  // Pin the saved id for the known silo, parent, request and retry references in this fixture.
  expect(rows.at(-1)!.event.id).toBe(
    'child-retry-9d5d5460a9d3693bcf84713fe3d4a0bc08d74cdaa5b4efaa7fad1aaa66ad7fbe');
  const repeated = await context.request(request.input.conversationId, request.path, request.payload);
  expect(repeated.body).toBe(response.body);
  const before = await context.nats.store.head();
  await recordChildStartFailure(context.options, request.saved.event.id, request.intent,
    'create', 'access_refused');
  expect(await context.nats.store.head()).toBe(before);
  expect(response.body).not.toContain(request.intent.childConversationId);
  expect(response.body).not.toContain('canary');
}
it('saves a requester retry and returns the same receipt', acceptsSavedFailure);

async function resumesMissingInput(created: boolean) {
  const request = await failedRequest(created);
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(202);
  await context.runner.run(childRequests);
  const indexed = await context.db.query(
    'SELECT failed_attempt FROM child_requests_v4 WHERE parent_id = $1',
    [request.input.conversationId]);
  expect(indexed.rows).toEqual([{ failed_attempt: null }]);
  const savedReference = reference(request);
  if (!created) {
    await expect(recoverChildRequest(context.options, savedReference)).rejects.toThrow();
    const child = await chatHistory(context.nats.store, 'test', request.intent.childConversationId);
    await context.auth.handler.handle(child[0]!.event, context.db);
  }
  await recoverChildRequest(context.options, savedReference);
  await recoverChildRequest(context.options, savedReference);
  const rows = await chatHistory(context.nats.store, 'test', request.intent.childConversationId);
  expect(rows).toHaveLength(3);
  expect(rows[1]!.event.id).toBe(request.intent.firstInputId);
  expect(rows[2]!.event).toMatchObject({ type: 'conversation.child_activated',
    data: { attempt: 2, payingGroupId: request.intent.payingGroupId,
      assistantId: request.intent.assistantId, requestedBy: request.intent.createdBy } });
  expect(rows[0]!.event.data).toMatchObject({ initialJoins: request.intent.initialJoins });
  expect(await context.intent(request.input.conversationId)).toEqual(request.intent);
  expect(await childRequestHeld(context.options, rows[0]!.event.data)).toBe(true);
  await context.runner.run(childRequests);
  const live = await context.db.query('SELECT * FROM child_requests_v4 ORDER BY intent_position');
  await context.runner.rebuild(childRequests);
  expect((await context.db.query('SELECT * FROM child_requests_v4 ORDER BY intent_position')).rows)
    .toEqual(live.rows);
  await context.runner.run(conversations);
  const feed = await context.request(request.input.conversationId, 'messages');
  expect(feed.statusCode).toBe(200);
  expect(feed.body).not.toMatch(/child_start_failed|child_retry_requested/u);
}
it.each([false, true])('resumes once with created=%s and rebuilds while held', resumesMissingInput);

async function conflicts(kind: string) {
  const request = await failedRequest(false, kind !== 'not-failed');
  if (kind === 'reuse') {
    expect((await context.request(request.input.conversationId, request.path,
      request.payload)).statusCode).toBe(202);
  }
  const payload = { ...request.payload, failureEventId: 'different-failure' };
  const before = await context.nats.store.head();
  const response = await context.request(request.input.conversationId, request.path, payload);
  expect(response.statusCode, response.body).toBe(409);
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['not-failed', 'stale', 'reuse'])('conflicts without writing for %s', conflicts);

async function hidesOtherRequester() {
  const request = await failedRequest();
  const before = await context.nats.store.head();
  const response = await context.request(request.input.conversationId, request.path,
    request.payload, 'bob');
  const unknown = await context.request(request.input.conversationId, 'children/unknown/retry',
    request.payload, 'bob');
  expect(response.statusCode).toBe(403);
  expect(response.body).toBe(unknown.body);
  expect(response.body).toBe('{"status":"refused"}');
  expect(await context.nats.store.head()).toBe(before);
}
it('refuses another requester exactly like an unknown request', hidesOtherRequester);

async function changesDuringHistory(kind: string) {
  const request = await failedRequest();
  const conversationId = request.input.conversationId;
  const original = context.nats.store.readStream.bind(context.nats.store);
  const paused = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let held = false;
  async function* read(...args: Parameters<typeof original>) {
    yield* original(...args);
    if (args[0] === `conversation-${conversationId}` && !held) {
      held = true;
      paused.resolve();
      await released.promise;
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(read);
  const pending = context.request(conversationId, request.path, request.payload);
  const response = pending.then(identity);
  await paused.promise;
  try {
    if (kind === 'closed') {
      await context.append(`participation-${conversationId}`, 'conversation.closed',
        { conversationId, closedBy: 'alice' }, false);
    } else {
      await context.append(`participation-${conversationId}`, 'participant.removed',
        { conversationId, participantId: 'alice', removedBy: 'bob' });
      if (kind === 'pre-join') {
        await context.append(`participation-${conversationId}`, 'participant.added',
          { conversationId, participantId: 'alice', addedBy: 'bob' });
      }
    }
  } finally {
    released.resolve();
  }
  const result = await response;
  expect(result.statusCode).toBe(kind === 'closed' ? 409 : 403);
  const rows = await chatHistory(context.nats.store, 'test', conversationId);
  expect(rows.filter(isRetry)).toHaveLength(0);
}
function identity<Value>(value: Value) {
  return value;
}
function isRetry(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'conversation.child_retry_requested';
}
it.each(['closed', 'removed', 'pre-join'])(
  'refuses %s during history loading without saving a retry', changesDuringHistory);

async function racesRetryIds() {
  const request = await failedRequest();
  const connection = await context.nats.client('command');
  const store = await createEventStore(connection);
  const otherOptions = { ...context.options, store };
  const other = buildServer(context.config, { chat: otherOptions });
  const ready = Promise.withResolvers<void>();
  let waiting = 0;
  function pausedAppend(original: typeof store.append) {
    return async function append(command: Parameters<typeof original>[0]) {
      waiting++;
      if (waiting === 2) ready.resolve();
      await ready.promise;
      return original(command);
    };
  }
  const firstAppend = pausedAppend(context.nats.store.append.bind(context.nats.store));
  const secondAppend = pausedAppend(store.append.bind(store));
  vi.spyOn(context.nats.store, 'append').mockImplementation(firstAppend);
  vi.spyOn(store, 'append').mockImplementation(secondAppend);
  try {
    const second = { ...request.payload, retryId: 'another-retry' };
    const firstResponse = context.request(request.input.conversationId, request.path, request.payload);
    const secondResponse = other.inject({ method: 'POST',
      url: `/api/conversations/${request.input.conversationId}/${request.path}`,
      headers: context.headers(), payload: second });
    const responses = await Promise.all([firstResponse, secondResponse]);
    expect(responses[0].statusCode).toBe(202);
    expect(responses[1].statusCode).toBe(202);
    expect(responses[1].body).toBe(responses[0].body);
    const rows = await chatHistory(context.nats.store, 'test', request.input.conversationId);
    expect(rows.filter(isRetry)).toHaveLength(1);
  } finally {
    await other.close();
  }
}
it('returns one receipt when two replicas race different retry ids', racesRetryIds);

async function laterFailures() {
  const request = await failedRequest(true);
  let failureEventId = request.payload.failureEventId;
  for (const attempt of [2, 3]) {
    const payload = { retryId: `attempt-${attempt}`, failureEventId };
    expect((await context.request(request.input.conversationId, request.path,
      payload)).statusCode).toBe(202);
    if (attempt === 3) {
      const stale = { ...request.payload, retryId: 'old-failure' };
      expect((await context.request(request.input.conversationId, request.path, stale)).statusCode)
        .toBe(409);
    }
    await context.append('team-payer', 'team.member_removed',
      { teamId: 'payer', memberId: 'alice', removedBy: 'bob' });
    try {
      await recoverChildRequest(context.options, reference(request));
      await recoverChildRequest(context.options, reference(request));
    } finally {
      await context.append('team-payer', 'team.member_added',
        { teamId: 'payer', memberId: 'alice', addedBy: 'alice' });
    }
    const status = await context.request(request.input.conversationId,
      `children/${request.input.requestId}`);
    expect(status.json()).toMatchObject({ state: 'failed', attempt });
    failureEventId = status.json<{ failureEventId: string }>().failureEventId;
    const stale = { retryId: 'stale', failureEventId: request.payload.failureEventId };
    expect((await context.request(request.input.conversationId, request.path, stale)).statusCode)
      .toBe(409);
  }
  const exhausted = { retryId: 'fourth', failureEventId };
  expect((await context.request(request.input.conversationId, request.path, exhausted)).statusCode)
    .toBe(409);
  const rows = await chatHistory(context.nats.store, 'test', request.input.conversationId);
  function isFailure(row: typeof rows[number]) {
    return row.event.type === 'conversation.child_start_failed';
  }
  expect(rows.filter(isFailure)).toHaveLength(3);
}
it('advances each later failure once and refuses retry after attempt three', laterFailures);
function reference(request: Awaited<ReturnType<typeof failedRequest>>) {
  return { silo: 'test', parent_id: request.input.conversationId,
    intent_id: request.saved.event.id, intent_position: request.saved.sequence,
    child_id: request.intent.childConversationId, first_input_id: request.intent.firstInputId };
}

async function lostReply() {
  const request = await failedRequest();
  const original = context.nats.store.append.bind(context.nats.store);
  async function lose(command: Parameters<typeof original>[0]): Promise<never> {
    await original(command);
    throw new Error('Lost reply');
  }
  const fault = vi.spyOn(context.nats.store, 'append').mockImplementation(lose);
  expect((await context.request(request.input.conversationId, request.path,
    request.payload)).statusCode).toBe(503);
  fault.mockRestore();
  const before = await chatHistory(context.nats.store, 'test', request.input.conversationId);
  await waitForDuplicateWindow(context.nats);
  await context.restart();
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual(before.at(-1)!.event.data);
  expect(await chatHistory(context.nats.store, 'test', request.input.conversationId)).toEqual(before);
}
it('reuses a lost reply after deduplication expires and restart', lostReply);

async function uncertainAccess(kind: string) {
  const request = await failedRequest();
  const original = authz.memberAuthorisation;
  function unavailable() {
    return Promise.resolve({ allowed: false as const, status: 'unavailable' as const,
      error: new Error('Unavailable') });
  }
  function unapplied() {
    return Promise.resolve(false);
  }
  function changed(...args: Parameters<typeof original>) {
    const auth = original(...args);
    if (kind === 'outage') return { ...auth, actsFor: unavailable };
    return { ...auth, applied: unapplied };
  }
  const fault = vi.spyOn(authz, 'memberAuthorisation').mockImplementation(changed);
  const before = await context.nats.store.head();
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(kind === 'outage' ? 503 : 425);
  expect(await context.nats.store.head()).toBe(before);
  fault.mockRestore();
  expect((await context.request(request.input.conversationId, request.path,
    request.payload)).statusCode).toBe(202);
}
it.each(['outage', 'applying'])('keeps %s retryable without saving a refusal', uncertainAccess);

async function hidesClosedParentFromRemovedRequester() {
  const request = await failedRequest();
  const conversationId = request.input.conversationId;
  await context.append(`participation-${conversationId}`, 'participant.removed',
    { conversationId, participantId: 'alice', removedBy: 'bob' });
  await context.append(`conversation-${conversationId}`, 'conversation.closed',
    { conversationId, closedBy: 'bob' }, false);
  const before = await context.nats.store.head();
  const response = await context.request(conversationId, request.path, request.payload);
  const unknown = await context.request(conversationId, 'children/unknown/retry', request.payload);
  expect(unknown.statusCode).toBe(403);
  expect(response.statusCode).toBe(unknown.statusCode);
  expect(response.body).toBe(unknown.body);
  expect(response.json()).toEqual({ status: 'refused' });
  expect(await context.nats.store.head()).toBe(before);
}
it('hides a closed parent from its removed requester', hidesClosedParentFromRemovedRequester);

async function ignoresOldWorkerAfterExpiry() {
  const request = await failedRequest();
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(202);
  await waitForDuplicateWindow(context.nats);
  const before = await context.nats.store.head();
  await recordChildStartFailure(context.options, request.saved.event.id, request.intent,
    'create', 'access_refused', 1);
  expect(await context.nats.store.head()).toBe(before);
  const status = await context.request(request.input.conversationId,
    `children/${request.input.requestId}`);
  expect(status.json()).toEqual({ requestId: request.input.requestId, state: 'queued' });
}
it('ignores an old worker after NATS deduplication expires', ignoresOldWorkerAfterExpiry);

async function keepsHistoryOutsideDeadline() {
  const request = await failedRequest();
  const original = context.nats.store.readStream.bind(context.nats.store);
  let completed = 0;
  async function* slow(...args: Parameters<typeof original>) {
    yield* original(...args);
    if (args[0] === `conversation-${request.input.conversationId}` && completed < 2) {
      completed++;
      await delay(2100);
    }
  }
  const readSpy = vi.spyOn(context.nats.store, 'readStream');
  readSpy.mockImplementation(slow);
  const receipt = await retryChildRequest(context.options, 'alice', request.input.conversationId,
    request.input.requestId, request.payload);
  expect(completed).toBe(2);
  expect(receipt).toMatchObject({ attempt: 2, retryId: request.payload.retryId });
}
it('loads both slow histories before starting the authority deadline', keepsHistoryOutsideDeadline);

async function doesNotRetryOtherConflicts() {
  const request = await failedRequest();
  const before = await context.nats.store.head();
  function changed(): Promise<never> {
    const error = new ChildRequestChanged('Saved record differs');
    return Promise.reject(error);
  }
  const append = vi.spyOn(context.nats.store, 'append');
  append.mockImplementation(changed);
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(409);
  expect(append).toHaveBeenCalledTimes(1);
  expect(await context.nats.store.head()).toBe(before);
}
it('does not repeat a write after a conflict other than an append race', doesNotRetryOtherConflicts);

async function rejectsOtherRequesterBeforeLoadingSource() {
  const request = await failedRequest();
  const original = context.nats.store.readStream.bind(context.nats.store);
  let histories = 0;
  async function* read(...args: Parameters<typeof original>) {
    if (args[0] === `conversation-${request.input.conversationId}`) {
      histories++;
      if (histories > 1) throw new Error('Source history must stay unread');
    }
    yield* original(...args);
  }
  const readSpy = vi.spyOn(context.nats.store, 'readStream');
  readSpy.mockImplementation(read);
  await expect(retryChildRequest(context.options, 'bob', request.input.conversationId,
    request.input.requestId, request.payload)).rejects.toThrow('Child request unavailable');
  expect(histories).toBe(1);
}
it('checks request ownership before loading source history', rejectsOtherRequesterBeforeLoadingSource);

async function ignoresOtherRequestReceipt() {
  const request = await failedRequest();
  const data = { ...request.payload, conversationId: request.input.conversationId,
    requestId: 'another-request', attempt: 2 };
  const event = { ...request.saved.event, id: 'other-request-retry',
    commandId: 'other-request-retry', type: 'conversation.child_retry_requested', data };
  await context.nats.seed([event]);
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({ requestId: request.input.requestId, attempt: 2 });
}
it('ignores another request receipt with the same retry id', ignoresOtherRequestReceipt);

async function doesNotReuseOtherFailureReceipt() {
  const request = await failedRequest();
  expect((await context.request(request.input.conversationId, request.path,
    request.payload)).statusCode).toBe(202);
  const payload = { retryId: 'another-retry', failureEventId: 'another-failure' };
  const before = await context.nats.store.head();
  const response = await context.request(request.input.conversationId, request.path, payload);
  expect(response.statusCode).toBe(409);
  expect(await context.nats.store.head()).toBe(before);
}
it('does not reuse a receipt for another failure', doesNotReuseOtherFailureReceipt);

async function recoversReceiptAfterLaterFailure() {
  const request = await failedRequest();
  const first = await context.request(request.input.conversationId, request.path, request.payload);
  expect(first.statusCode).toBe(202);
  await recordChildStartFailure(context.options, request.saved.event.id, request.intent,
    'create', 'access_refused', 2);
  const before = await context.nats.store.head();
  const repeated = await context.request(request.input.conversationId, request.path, request.payload);
  expect(repeated.statusCode).toBe(202);
  expect(repeated.body).toBe(first.body);
  expect(await context.nats.store.head()).toBe(before);
}
it('recovers the same retry receipt after a later failure', recoversReceiptAfterLaterFailure);

async function refusesClosedParentForCurrentRequester() {
  const request = await failedRequest();
  const conversationId = request.input.conversationId;
  await context.append(`conversation-${conversationId}`, 'conversation.closed',
    { conversationId, closedBy: 'alice' }, false);
  const before = await context.nats.store.head();
  const response = await context.request(conversationId, request.path, request.payload);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'conflict' });
  expect(await context.nats.store.head()).toBe(before);
}
it('still refuses a legacy closed parent for its current requester',
  refusesClosedParentForCurrentRequester);

async function keepsSavedFailureAfterExpiry() {
  const request = await failedRequest();
  await waitForDuplicateWindow(context.nats);
  const before = await context.nats.store.head();
  await recordChildStartFailure(context.options, request.saved.event.id, request.intent,
    'create', 'access_refused', 1);
  expect(await context.nats.store.head()).toBe(before);
}
it('keeps one saved failure after NATS deduplication expires', keepsSavedFailureAfterExpiry);
