import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import * as authz from '@opencrane/authz';
import { eventEnvelopeSchema, conversationCreatedDataSchema } from '@opencrane/events';
import { childRequests, conversations } from '@opencrane/projections';
import type { Db } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { chatHistory } from '../src/chat/commands.ts';
import { recoverChildRequest, watchChildRequests } from '../src/chat/child-recovery.ts';
import { recordChildStartFailure } from '../src/chat/child-failure.ts';
import { startServer, parseJsonLines } from './support/process.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
const eventSchema = eventEnvelopeSchema(z.unknown());
const logger = createLogger('child-recovery-test');
async function setup() {
  context = await summonFixture();
  await context.runner.initialise(childRequests);
}
async function cleanup() {
  await context.close();
}
beforeAll(setup, 60_000);
afterAll(cleanup);
async function resetAccess() {
  vi.restoreAllMocks();
  for (const teamId of ['owners', 'payer']) {
    await context.append(`team-${teamId}`, 'team.member_added',
      { teamId, memberId: 'alice', addedBy: 'alice' });
  }
}
afterEach(resetAccess);

async function recoveryUsesReadOnlyProjectionAccess() {
  let completedReads = 0;
  async function readOnlyQuery<Row extends Record<string, unknown>>(
    sql: string, parameters?: unknown[]) {
    expect(sql.trimStart()).toMatch(/^SELECT\b/u);
    const result = await context.db.query<Row>(sql, parameters);
    completedReads++;
    return result;
  }
  function refuseTransaction<Result>(): Promise<Result> {
    return Promise.reject(new Error('Read-only connection cannot write'));
  }
  const readonlyDb: Db = { query: readOnlyQuery, transaction: refuseTransaction };
  const stop = new AbortController();
  const options = { ...context.options, db: readonlyDb };
  const running = watchChildRequests(options, logger, stop.signal);
  const result = running.then(() => undefined, (error: unknown) => error);
  await delay(100);
  stop.abort();
  expect(await result).toBeUndefined();
  expect(completedReads).toBeGreaterThan(0);
}
it('recovers using a read-only projection connection', recoveryUsesReadOnlyProjectionAccess);

async function savedRequest(stage: string) {
  const input = await context.parent();
  const { conversationId, ...payload } = input;
  const reviewed = await context.request(conversationId, 'child-review', payload);
  expect(reviewed.statusCode).toBe(200);
  const start = { requestId: input.requestId, sourceMessageId: input.sourceMessageId,
    review: reviewed.json<{ review: string }>().review };
  const original = context.nats.store.append.bind(context.nats.store);
  async function crash(command: Parameters<typeof original>[0]) {
    const result = await original(command);
    const event = eventSchema.parse(command.event);
    if (event.type === 'conversation.created') {
      await context.auth.handler.handle(event, context.db);
    }
    if (event.type === stage) {
      throw new Error('Crash after save');
    }
    return result;
  }
  const fault = vi.spyOn(context.nats.store, 'append').mockImplementation(crash);
  const response = await context.request(conversationId, 'children', start);
  fault.mockRestore();
  expect(response.statusCode, response.body).toBe(503);
  const intent = await context.intent(conversationId);
  await context.restart();
  await context.runner.run(childRequests);
  return { input, start, intent };
}
function applyCreationPermissions() {
  const original = context.nats.store.append.bind(context.nats.store);
  async function append(command: Parameters<typeof original>[0]) {
    const result = await original(command);
    const event = eventSchema.parse(command.event);
    if (event.type === 'conversation.created') {
      await context.auth.handler.handle(event, context.db);
    }
    return result;
  }
  vi.spyOn(context.nats.store, 'append').mockImplementation(append);
}
function worker() {
  const stop = new AbortController();
  const options = { ...context.options, db: context.db };
  const running = watchChildRequests(options, logger, stop.signal);
  async function close() {
    stop.abort();
    await running;
  }
  return close;
}
async function waitForInput(child: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await chatHistory(context.nats.store, 'test', child);
    if (rows.length === 2) {
      return rows;
    }
    await delay(100);
  }
  throw new Error('Recovery did not save the first input');
}
async function recoversWithoutPost(stage: string) {
  const { input, intent } = await savedRequest(stage);
  applyCreationPermissions();
  const stop = worker();
  try {
    const rows = await waitForInput(intent.childConversationId);
    expect(rows[1]!.event.id).toBe(intent.firstInputId);
    const creation = conversationCreatedDataSchema.parse(rows[0]!.event.data);
    expect(creation).toMatchObject({ initialJoins: intent.initialJoins });
    expect(context.keys.decrypt('test', intent.childConversationId, rows[1]!.event.data))
      .toBe('@Assistant source canary');
    const status = await context.request(input.conversationId, `children/${input.requestId}`);
    expect(status.json()).toMatchObject({ state: 'queued' });
    expect(status.body).not.toContain('canary');
  } finally {
    await stop();
  }
}
it.each(['conversation.child_requested', 'conversation.created', 'message.posted'])(
  'recovers after %s without another POST', recoversWithoutPost);

async function retriesUntilWorkerBuildsTable() {
  const { intent } = await savedRequest('conversation.child_requested');
  // Remove the test's earlier projection records to model a fresh installation.
  await context.db.query('DROP TABLE child_requests_v2');
  await context.db.query('DELETE FROM projection_checkpoints WHERE name = $1',
    [childRequests.name]);
  await context.db.query('DELETE FROM projection_events WHERE projection = $1',
    [childRequests.name]);
  await context.db.query('DELETE FROM projection_generations WHERE name = $1',
    [childRequests.name]);
  applyCreationPermissions();
  const warnings = vi.spyOn(logger, 'warn');
  const before = await context.nats.store.head();
  const stop = worker();
  function expectRetries() {
    expect(warnings.mock.calls.length).toBeGreaterThanOrEqual(2);
  }
  try {
    await vi.waitFor(expectRetries, { timeout: 5_000, interval: 50 });
    expect(await context.nats.store.head()).toBe(before);
    expect(await chatHistory(context.nats.store, 'test', intent.childConversationId))
      .toHaveLength(0);
    await context.runner.initialise(childRequests);
    await context.runner.run(childRequests);
    const rows = await waitForInput(intent.childConversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.event.id).toBe(intent.firstInputId);
  } finally {
    await stop();
  }
}
it('retries without child work until the worker creates and fills the missing table',
  retriesUntilWorkerBuildsTable);

async function racesWithPost() {
  const { input, start, intent } = await savedRequest('conversation.child_requested');
  applyCreationPermissions();
  const first = worker();
  const second = worker();
  try {
    await context.request(input.conversationId, 'children', start);
    await waitForInput(intent.childConversationId);
  } finally {
    await first();
    await second();
  }
  expect(await chatHistory(context.nats.store, 'test', intent.childConversationId)).toHaveLength(2);
  const rows = await chatHistory(context.nats.store, 'test', input.conversationId);
  function isIntent(row: typeof rows[number]) {
    return row.event.type === 'conversation.child_requested';
  }
  expect(rows.filter(isIntent)).toHaveLength(1);
}
it('keeps one child and input when two workers race a retried POST', racesWithPost);

async function reference(parent: string) {
  await context.runner.initialise(childRequests);
  await context.runner.run(childRequests);
  const result = await context.db.query(
    'SELECT * FROM child_requests_v2 WHERE silo = $1 AND parent_id = $2', ['test', parent]);
  const { failed_attempt: _failed, ...reference } = result.rows[0]!;
  return reference;
}
async function refusesChangedReferences() {
  const { input } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  const before = await context.nats.store.head();
  const changes = [{ silo: 'foreign' }, { parent_id: 'foreign' }, { intent_id: 'foreign' },
    { intent_position: Number(row['intent_position']) - 1 }, { child_id: 'foreign' },
    { first_input_id: 'foreign' }, { text: 'private canary' }];
  for (const patch of changes) {
    await expect(recoverChildRequest(context.options, { ...row, ...patch })).rejects.toThrow();
  }
  expect(await context.nats.store.head()).toBe(before);
}
it('refuses foreign or changed index records without an append', refusesChangedReferences);

async function rebuildsWithoutEffects() {
  const { input } = await savedRequest('conversation.child_requested');
  await reference(input.conversationId);
  const before = await context.nats.store.head();
  const original = await context.db.query('SELECT * FROM child_requests_v2 ORDER BY intent_position');
  expect(JSON.stringify(original.rows)).not.toContain('canary');
  await context.runner.rebuild(childRequests);
  const rebuilt = await context.db.query('SELECT * FROM child_requests_v2 ORDER BY intent_position');
  expect(rebuilt.rows).toEqual(original.rows);
  expect(await context.nats.store.head()).toBe(before);
}
it('rebuilds the unfinished index from events without effects or source text', rebuildsWithoutEffects);

async function refusesAfterAccessChanges(stage: string, kind: string) {
  const { input, intent } = await savedRequest(stage);
  const row = await reference(input.conversationId);
  if (kind === 'closed') {
    await context.append(`conversation-${input.conversationId}`, 'conversation.closed',
      { conversationId: input.conversationId, closedBy: 'alice' }, false);
  } else if (kind === 'requester') {
    await context.append(`participation-${input.conversationId}`, 'participant.removed',
      { conversationId: input.conversationId, participantId: 'alice', removedBy: 'bob' });
  } else if (kind === 'payer' || kind === 'assistant') {
    const teamId = kind === 'payer' ? 'payer' : 'owners';
    await context.append(`team-${teamId}`, 'team.member_removed',
      { teamId, memberId: 'alice', removedBy: 'bob' });
  } else {
    const original = authz.memberAuthorisation;
    function unavailable() {
      return Promise.resolve({ allowed: false as const, status: 'unavailable' as const,
        error: new Error('IAM unavailable') });
    }
    function outage(...args: Parameters<typeof original>) {
      return { ...original(...args), actsFor: unavailable };
    }
    vi.spyOn(authz, 'memberAuthorisation').mockImplementation(outage);
  }
  const before = await context.nats.store.head();
  if (kind === 'iam') {
    await expect(recoverChildRequest(context.options, row)).rejects.toThrow();
    expect(await context.nats.store.head()).toBe(before);
  } else {
    await recoverChildRequest(context.options, row);
    const history = await chatHistory(context.nats.store, 'test', input.conversationId);
    const failure = history.at(-1)!.event;
    const reason = kind === 'closed' ? 'conversation_closed' : 'access_refused';
    const failedStage = stage === 'conversation.created' ? 'first_input' : 'create';
    expect(failure).toMatchObject({ type: 'conversation.child_start_failed',
      data: { requestId: input.requestId, attempt: 1, stage: failedStage, reason } });
    await recoverChildRequest(context.options, row);
    expect(await context.nats.store.head()).toBe(before + 1);
  }
  const rows = await chatHistory(context.nats.store, 'test', intent.childConversationId);
  expect(rows.length).toBe(stage === 'conversation.child_requested' ? 0 : 1);
}
const refusedCases: [string, string][] = [];
for (const stage of ['conversation.child_requested', 'conversation.created']) {
  for (const kind of ['closed', 'requester', 'payer', 'assistant', 'iam']) {
    refusedCases.push([stage, kind]);
  }
}
it.each(refusedCases)('holds after %s when %s changes', refusesAfterAccessChanges);

async function keepsOriginalJoins() {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  await context.append(`participation-${input.conversationId}`, 'participant.removed',
    { conversationId: input.conversationId, participantId: 'bob', removedBy: 'alice' });
  applyCreationPermissions();
  await recoverChildRequest(context.options, row);
  const rows = await chatHistory(context.nats.store, 'test', intent.childConversationId);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.event.data).toMatchObject({ initialJoins: intent.initialJoins });
}
it('keeps the original joins when another participant has left', keepsOriginalJoins);

async function savesOneFailureAndStops() {
  const { input, start, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  await context.append('team-payer', 'team.member_removed',
    { teamId: 'payer', memberId: 'alice', removedBy: 'bob' });
  await Promise.allSettled([recoverChildRequest(context.options, row),
    recoverChildRequest(context.options, row)]);
  const parent = await chatHistory(context.nats.store, 'test', input.conversationId);
  const failure = parent.at(-1)!.event;
  expect(parent.filter(isFailure)).toHaveLength(1);
  const status = await context.request(input.conversationId, `children/${input.requestId}`);
  expect(status.json()).toEqual({ state: 'failed', requestId: input.requestId,
    stage: 'create', reason: 'access_refused', attempt: 1, failureEventId: failure.id });
  expect(status.body).not.toContain('canary');
  const hidden = await context.request(input.conversationId, `children/${input.requestId}`,
    undefined, 'bob');
  expect(hidden.json()).toEqual({ state: 'unknown' });
  const { conversationId, ...reviewInput } = input;
  const refused = await context.request(conversationId, 'child-review', reviewInput, 'bob');
  expect(refused.statusCode).toBe(403);
  await resetAccess();
  await recoverChildRequest(context.options, row);
  const before = await context.nats.store.head(`conversation-${input.conversationId}`);
  expect((await context.request(input.conversationId, 'children', start)).statusCode).toBe(409);
  await context.runner.run(childRequests);
  const indexed = await context.db.query('SELECT * FROM child_requests_v2 ORDER BY intent_position');
  await context.runner.rebuild(childRequests);
  expect((await context.db.query('SELECT * FROM child_requests_v2 ORDER BY intent_position')).rows)
    .toEqual(indexed.rows);
  const reads = vi.spyOn(context.nats.store, 'readStream');
  const stop = worker();
  await delay(1200);
  await stop();
  for (const [subject] of reads.mock.calls) {
    expect(subject).not.toBe(`conversation-${input.conversationId}`);
  }
  reads.mockRestore();
  expect(await context.nats.store.head(`conversation-${input.conversationId}`)).toBe(before);
  expect(await chatHistory(context.nats.store, 'test', intent.childConversationId)).toHaveLength(0);
  await context.runner.run(conversations);
  const feed = await context.request(input.conversationId, 'messages');
  expect(feed.statusCode, feed.body).toBe(200);
  expect(feed.body).not.toContain('child_start_failed');
  expect(feed.body).not.toContain(failure.id);
  await context.append(`participation-${conversationId}`, 'participant.removed',
    { conversationId, participantId: 'alice', removedBy: 'bob' });
  const removed = await context.request(conversationId, 'child-review', reviewInput);
  expect(removed.statusCode).toBe(403);
}
function isFailure(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'conversation.child_start_failed';
}
it('saves one racing refusal, hides it from other readers and never resumes it', savesOneFailureAndStops);

async function processRecoversAndStops(fault: string) {
  const { intent } = await savedRequest('conversation.child_requested');
  await context.runner.run(conversations);
  const binding = context.options.binding;
  const server = await startServer({ ...context.nats.env(), SILO_ID: 'test',
    OIDC_EXPECTED_ORG_ID: 'org-test', DATABASE_URL: context.databaseUrl,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId,
    OPENFGA_MODEL_ID: binding.authorizationModelId, CONVERSATION_KEYS_DIR: context.directory,
    KUBECONFIG: '/unused-child-recovery-test', KUBE_NAMESPACE: 'child-recovery-test',
    TEST_PROCESS_FAULTS: '1', TEST_CHILD_RECOVERY: fault, SHUTDOWN_GRACE_MS: '5000' });
  try {
    if (fault === 'fail') {
      expect(await server.exited).toMatchObject({ code: 1, signal: null });
      const lines = parseJsonLines(server.stdout());
      function fatal(line: Record<string, unknown>) {
        return line['msg'] === 'Child recovery stopped; restarting the server';
      }
      expect(lines.filter(fatal)).toHaveLength(1);
    } else {
      for (let attempt = 0; attempt < 100; attempt++) {
        const child = await chatHistory(context.nats.store, 'test', intent.childConversationId);
        if (child[0]) {
          await context.auth.handler.handle(child[0].event, context.db);
          break;
        }
        await delay(100);
      }
      await waitForInput(intent.childConversationId);
      await server.stop();
      const output = server.stdout();
      const stopped = output.indexOf('Child recovery stopped cleanly');
      expect(stopped).toBeGreaterThan(-1);
      expect(output.indexOf('event store connection closed')).toBeGreaterThan(stopped);
    }
  } finally {
    await server.stop();
  }
}
it.each(['recover', 'fail'])('runs configured recovery and handles process %s',
  processRecoversAndStops);

async function keepsUncertainWorkQueued(kind: string) {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  if (kind === 'outage') await context.fga.pause();
  try {
    await expect(recoverChildRequest(context.options, row)).rejects.toThrow();
    const parent = await chatHistory(context.nats.store, 'test', input.conversationId);
    expect(parent.filter(isFailure)).toHaveLength(0);
    expect((await context.request(input.conversationId, `children/${input.requestId}`)).body)
      .not.toContain('failed');
  } finally {
    if (kind === 'outage') await context.fga.resume();
  }
  const child = await chatHistory(context.nats.store, 'test', intent.childConversationId);
  if (child[0]) await context.auth.handler.handle(child[0].event, context.db);
  applyCreationPermissions();
  await recoverChildRequest(context.options, row);
  expect(await chatHistory(context.nats.store, 'test', intent.childConversationId)).toHaveLength(2);
}
it.each(['outage', 'applying'])('keeps %s queued then completes missing saves', keepsUncertainWorkQueued);

async function losesFailureReply() {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  await context.append(`conversation-${input.conversationId}`, 'conversation.closed',
    { conversationId: input.conversationId, closedBy: 'alice' }, false);
  const original = context.nats.store.append.bind(context.nats.store);
  async function loseReply(command: Parameters<typeof original>[0]): Promise<never> {
    await original(command);
    throw new Error('Reply lost');
  }
  const fault = vi.spyOn(context.nats.store, 'append').mockImplementation(loseReply);
  await expect(recoverChildRequest(context.options, row)).rejects.toThrow('Reply lost');
  fault.mockRestore();
  const before = await chatHistory(context.nats.store, 'test', input.conversationId);
  await delay(120_100);
  await context.restart();
  await recoverChildRequest(context.options, row);
  await recordChildStartFailure(context.options, String(row['intent_id']), intent,
    'create', 'conversation_closed');
  expect(await chatHistory(context.nats.store, 'test', input.conversationId)).toEqual(before);
  expect(before.filter(isFailure)).toHaveLength(1);
}
it('keeps the saved failure after a lost reply beyond the duplicate window',
  losesFailureReply, 180_000);

async function refusesChangedChild() {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  await context.append(`conversation-${intent.childConversationId}`, 'conversation.created',
    { conversationId: intent.childConversationId, mode: 'group', createdBy: 'alice',
      participantIds: ['alice', 'bob'] });
  await recoverChildRequest(context.options, row);
  const parent = await chatHistory(context.nats.store, 'test', input.conversationId);
  expect(parent.at(-1)!.event).toMatchObject({ type: 'conversation.child_start_failed',
    data: { stage: 'first_input', reason: 'record_changed', attempt: 1 } });
  expect(await chatHistory(context.nats.store, 'test', intent.childConversationId)).toHaveLength(1);
}
it('records a changed child without replacing its saved creation', refusesChangedChild);

async function appliesCreationAfterPermissionRead() {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  const denied = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const original = authz.memberAuthorisation;
  function delayedPermission(...args: Parameters<typeof original>) {
    const auth = original(...args);
    async function conversation(...parameters: Parameters<typeof auth.conversation>) {
      const permission = await auth.conversation(...parameters);
      if (parameters[1] === intent.childConversationId && !permission.allowed) {
        denied.resolve();
        await applied.promise;
      }
      return permission;
    }
    return { ...auth, conversation };
  }
  const fault = vi.spyOn(authz, 'memberAuthorisation').mockImplementation(delayedPermission);
  const recovery = recoverChildRequest(context.options, row);
  const settled = Promise.allSettled([recovery]);
  await denied.promise;
  try {
    const child = await chatHistory(context.nats.store, 'test', intent.childConversationId);
    await context.auth.handler.handle(child[0]!.event, context.db);
  } finally {
    applied.resolve();
  }
  await settled;
  fault.mockRestore();
  const parent = await chatHistory(context.nats.store, 'test', input.conversationId);
  expect(parent.filter(isFailure)).toHaveLength(0);
  await recoverChildRequest(context.options, row);
  await recoverChildRequest(context.options, row);
  const child = await chatHistory(context.nats.store, 'test', intent.childConversationId);
  expect(child).toHaveLength(2);
  expect(child[1]!.event.id).toBe(intent.firstInputId);
}
it('retries a denial read before the child creation receipt without saving failure',
  appliesCreationAfterPermissionRead);

async function retriesUnavailableSaveOrKey(kind: string) {
  const { input, intent } = await savedRequest('conversation.created');
  const row = await reference(input.conversationId);
  function unreadable(): never {
    throw new Error('Key unavailable');
  }
  async function unavailable() {
    return { status: 'unavailable' as const, cause: new Error('Append unavailable') };
  }
  const fault = kind === 'key'
    ? vi.spyOn(context.keys, 'decrypt').mockImplementation(unreadable)
    : vi.spyOn(context.nats.store, 'append').mockImplementation(unavailable);
  const message = kind === 'key' ? 'Child input unavailable' : 'Child request outcome unavailable';
  await expect(recoverChildRequest(context.options, row)).rejects.toThrow(message);
  expect(fault).toHaveBeenCalled();
  fault.mockRestore();
  const parent = await chatHistory(context.nats.store, 'test', input.conversationId);
  expect(parent.filter(isFailure)).toHaveLength(0);
  await recoverChildRequest(context.options, row);
  const child = await chatHistory(context.nats.store, 'test', intent.childConversationId);
  expect(child).toHaveLength(2);
  expect(child[1]!.event.id).toBe(intent.firstInputId);
}
it.each(['append', 'key'])('keeps an unavailable %s retryable without saving failure',
  retriesUnavailableSaveOrKey);

async function hidesFailedStatus(kind: string) {
  const { input, intent } = await savedRequest('conversation.child_requested');
  const row = await reference(input.conversationId);
  await recordChildStartFailure(context.options, String(row['intent_id']), intent,
    'create', 'access_refused');
  let conversationId = input.conversationId;
  let memberId = 'alice';
  if (kind === 'removed member') {
    await context.append('member-alice', 'member.removed',
      { memberId: 'alice', removedBy: 'bob' }, false);
  } else if (kind === 'removed') {
    await context.append(`participation-${conversationId}`, 'participant.removed',
      { conversationId, participantId: 'alice', removedBy: 'bob' });
  } else if (kind === 'outsider') {
    memberId = 'bob';
    await context.append(`participation-${conversationId}`, 'participant.removed',
      { conversationId, participantId: memberId, removedBy: 'alice' });
  } else if (kind === 'different chat') {
    const other = await context.parent();
    conversationId = other.conversationId;
  } else {
    await context.append(`participation-${conversationId}`, 'participant.removed',
      { conversationId, participantId: 'alice', removedBy: 'bob' });
    await context.append(`participation-${conversationId}`, 'participant.added',
      { conversationId, participantId: 'alice', addedBy: 'bob' });
  }
  const unknown = await context.request(conversationId, 'children/unknown', undefined, memberId);
  const failed = await context.request(conversationId, `children/${input.requestId}`,
    undefined, memberId);
  const readable = kind === 'different chat' || kind === 'pre-join';
  expect(unknown.statusCode).toBe(readable ? 200 : 403);
  expect(failed.statusCode).toBe(unknown.statusCode);
  expect(failed.body).toBe(unknown.body);
  expect(failed.body).not.toContain('failed');
  expect(failed.body).not.toContain(intent.childConversationId);
}
it.each(['removed', 'outsider', 'different chat', 'pre-join'])(
  'hides failed status like an unknown request for %s', hidesFailedStatus);

async function storesExactAttemptAndDeletesCompletedRow() {
  const failed = await savedRequest('conversation.child_requested');
  const failedRow = await reference(failed.input.conversationId);
  const parent = await chatHistory(context.nats.store, 'test', failed.input.conversationId);
  const intentEvent = parent.at(-1)!.event;
  const failure = { ...intentEvent, id: `${intentEvent.id}-failed`,
    commandId: `${intentEvent.id}-failed`,
    type: 'conversation.child_start_failed', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    data: { conversationId: failed.input.conversationId, requestId: failed.input.requestId,
      intentEventId: intentEvent.id, childConversationId: failed.intent.childConversationId,
      attempt: 3, stage: 'create', reason: 'access_refused' } };
  await childRequests.apply(context.db, failure, 1);
  const indexed = await context.db.query(
    'SELECT failed_attempt FROM child_requests_v2 WHERE intent_id = $1',
    [failedRow['intent_id']]);
  expect(indexed.rows).toEqual([{ failed_attempt: 3 }]);
  const completed = await savedRequest('conversation.created');
  await recoverChildRequest(context.options, await reference(completed.input.conversationId));
  await context.runner.run(childRequests);
  const remaining = await context.db.query(
    'SELECT * FROM child_requests_v2 WHERE child_id = $1', [completed.intent.childConversationId]);
  expect(remaining.rows).toEqual([]);
}
it('stores the exact failed attempt and deletes the completed child index row',
  storesExactAttemptAndDeletesCompletedRow);

async function hidesFailureFromRemovedMember() {
  const previous = context;
  await setup();
  try {
    await hidesFailedStatus('removed member');
  } finally {
    await context.close();
    context = previous;
  }
}
it('hides failed status like an unknown request for a removed silo member',
  hidesFailureFromRemovedMember);
