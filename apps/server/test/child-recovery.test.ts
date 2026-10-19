import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import * as authz from '@opencrane/authz';
import { eventEnvelopeSchema, conversationCreatedDataSchema } from '@opencrane/events';
import { childRequests } from '@opencrane/projections';
import type { Db } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { chatHistory } from '../src/chat/commands.ts';
import { recoverChildRequest, watchChildRequests } from '../src/chat/child-recovery.ts';
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
  await context.db.query('DROP TABLE child_requests');
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
    'SELECT * FROM child_requests WHERE silo = $1 AND parent_id = $2', ['test', parent]);
  return result.rows[0]!;
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
  const original = await context.db.query('SELECT * FROM child_requests ORDER BY intent_position');
  expect(JSON.stringify(original.rows)).not.toContain('canary');
  await context.runner.rebuild(childRequests);
  const rebuilt = await context.db.query('SELECT * FROM child_requests ORDER BY intent_position');
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
  await expect(recoverChildRequest(context.options, row)).rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
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
