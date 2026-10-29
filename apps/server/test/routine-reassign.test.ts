import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import type { AppendCommand } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { foldRoutine, getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '@opencrane/projections';
import { history } from '@opencrane/models';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { database } from '../../../libs/projections/test/database.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import { reassignRoutine } from '../src/routine-reassign.ts';
import { retireRoutine } from '../src/routine-retire.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let input: { changeId: string; routineId: string; ownerId: string; expectedPosition: number;
  expectedDefinitionRevision: number; expectedScheduleRevision: number;
  expectedControlRevision: number };
const original = foldRoutine(undefined, routine('routine.created')).definition!;
function noSql(): never {
  throw new Error('Unexpected SQL write');
}
const db = { query: noSql };
function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
async function apply(records: EventEnvelope[]) {
  await nats.seed(records);
  const auth = memberAuthorisation(binding, nats.store);
  for (const saved of records) await auth.handler.handle(saved, db);
}
async function setup() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const records = ['alice', 'admin', 'bob', 'carol'].map(joinedMember);
  for (const teamId of ['sales', 'billing']) {
    records.push(record(`created-${teamId}`, `team-${teamId}`, 'team.created',
      { teamId, name: teamId, createdBy: 'alice' }));
    for (const memberId of ['alice', 'bob', 'carol']) {
      records.push(record(`added-${teamId}-${memberId}`, `team-${teamId}`, 'team.member_added',
        { teamId, memberId, addedBy: 'alice' }));
    }
  }
  records.push(record('assistant', 'assistant-sales-assistant', 'assistant.created',
    { assistantId: 'sales-assistant', kind: 'team', ownerId: 'billing', payingGroupId: 'sales' }));
  records.push(routine('routine.created'));
  await apply(records);
  input = { changeId: 'orders:reassign', routineId: 'orders', ownerId: 'bob',
    expectedPosition: await nats.store.head('routine-orders'), expectedDefinitionRevision: 1,
    expectedScheduleRevision: 1, expectedControlRevision: 1 };
}
async function cleanup() {
  vi.restoreAllMocks();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function reassign(memberId = 'admin', request: unknown = input) {
  return reassignRoutine(nats.store, binding, memberId, request);
}
function rows() {
  return history(nats.store, 'routine-orders', 'test', performance.now() + 10_000);
}
async function applySaved() {
  const saved = await rows();
  await memberAuthorisation(binding, nats.store).handler.handle(saved.at(-1)!.event, db);
}
async function saveRoutine(type: string) {
  const data = getEventDefinition(type)!.example;
  const saved = record(type, 'routine-orders', type, data);
  let actorId = 'opencrane-server';
  if (data && typeof data === 'object' && 'actorId' in data) actorId = String(data.actorId);
  saved.principal = { kind: actorId === 'opencrane-server' ? 'system' : 'human', id: actorId };
  await nats.seed([saved]);
  input.expectedPosition = await nats.store.head('routine-orders');
  let state = foldRoutine(undefined, routine('routine.created'));
  for (const row of await rows()) state = foldRoutine(state, row.event);
  input.expectedControlRevision = state.definition!.controlRevision;
}
async function changeMember(memberId = 'admin', type = 'member.role_changed') {
  let data: unknown = { memberId, previousRole: 'admin', newRole: 'member', changedBy: 'alice' };
  if (type === 'member.removed') data = { memberId, removedBy: 'alice' };
  const changed = record(`${memberId}-${type}`, `member-${memberId}`, type, data);
  await nats.seed([changed]);
}

async function savesOnce() {
  const before = await nats.store.head();
  const [first, concurrent] = await Promise.all([reassign(), reassign()]);
  expect(concurrent).toEqual(first);
  expect(await nats.store.head()).toBe(before + 1);
  expect(Object.keys(first).sort()).toEqual(['changeId', 'eventId', 'position', 'status']);
  const saved = await rows();
  expect(saved.at(-1)!.event).toMatchObject({ type: 'routine.reassigned',
    principal: { kind: 'human', id: 'admin' }, data: { actorId: 'admin', source: 'admin',
      affectedRun: null, definitionRevision: 2, scheduleRevision: 1, controlRevision: 2,
      next: original.next, definition: { ...original.definition,
        ownerId: 'bob', ownerAdmissionId: 'joined-bob' } } });
  await applySaved();
  expect(await reassign()).toEqual(first);
  const auth = memberAuthorisation(binding, nats.store);
  expect((await auth.routine('bob', 'orders', 'manage')).allowed).toBe(true);
  expect((await auth.routine('alice', 'orders', 'read_metadata')).allowed).toBe(false);
  expect((await auth.routine('admin', 'orders', 'manage')).allowed).toBe(false);
  expect((await auth.actsFor('admin', 'sales-assistant')).allowed).toBe(false);
}
it('saves one paused reassignment for identical races, preserving every other definition field', savesOnce);

async function refuses(kind: string) {
  let memberId = 'admin';
  if (kind === 'ordinary owner') memberId = 'alice';
  if (kind === 'ordinary member') memberId = 'carol';
  if (kind === 'removed admin') await changeMember('admin', 'member.removed');
  if (kind === 'demoted admin') await changeMember();
  if (kind === 'removed recipient') await changeMember('bob', 'member.removed');
  if (kind === 'missing recipient') input.ownerId = 'missing';
  if (kind === 'same owner') input.ownerId = 'alice';
  if (kind === 'active') await saveRoutine('routine.resumed');
  if (kind === 'retired') await saveRoutine('routine.retired');
  if (kind === 'occupied' || kind === 'stopped') {
    await saveRoutine('routine.resumed');
    await saveRoutine('routine.due');
    if (kind === 'stopped') await saveRoutine('routine.run_stop_requested');
    await saveRoutine('routine.paused');
  }
  if (kind === 'legacy') {
    const legacy = record('legacy', 'routine-old', 'routine.created',
      { routineId: 'old', assistantId: 'assistant', schedule: '* * * * *', createdBy: 'alice' });
    await apply([legacy]);
    input.routineId = 'old';
  }
  if (kind === 'routine receipt') await nats.seed([routine('routine.reassigned', 'carol')]);
  if (kind === 'role receipt') {
    const promoted = record('promoted', 'member-admin', 'member.role_changed',
      { memberId: 'admin', previousRole: 'admin', newRole: 'admin', changedBy: 'alice' });
    await nats.seed([promoted]);
  }
  if (kind === 'recipient receipt') {
    const joined = { ...joinedMember('bob'), id: 'joined-again', commandId: 'joined-again' };
    await nats.seed([joined]);
  }
  if (kind === 'assistant inactive') {
    await nats.seed([record('inactive', 'assistant-sales-assistant', 'assistant.settings_changed',
      { assistantId: 'sales-assistant', active: false, changedBy: 'alice', changedFields: ['active'] })]);
  }
  if (kind === 'payer lost' || kind === 'assistant group lost') {
    let teamId = 'sales';
    if (kind === 'assistant group lost') teamId = 'billing';
    await nats.seed([record('lost', `team-${teamId}`, 'team.member_removed',
      { teamId, memberId: 'bob', removedBy: 'alice' })]);
  }
  const before = await nats.store.head();
  await expect(reassign(memberId, { ...input, expectedPosition: 0 }))
    .rejects.toThrow(/^Routine reassignment refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['ordinary owner', 'ordinary member', 'removed admin', 'demoted admin',
  'removed recipient', 'missing recipient', 'same owner', 'active', 'retired', 'occupied',
  'stopped', 'legacy', 'routine receipt', 'role receipt', 'recipient receipt',
  'assistant inactive', 'payer lost', 'assistant group lost'])(
  'refuses %s before revealing a conflict', refuses);

async function privateRetry(kind: string) {
  await reassign();
  if (kind !== 'unapplied receipt') await applySaved();
  if (kind === 'removed admin') await changeMember('admin', 'member.removed');
  if (kind === 'demoted admin' || kind === 'demoted admin with failed ownership') {
    await changeMember();
  }
  if (kind === 'removed recipient') await changeMember('bob', 'member.removed');
  const read = nats.store.readStream.bind(nats.store);
  async function* failed(subject: string, from?: number, deadline?: number) {
    const failedOwnership = kind === 'removed admin' || kind === 'demoted admin with failed ownership';
    if (failedOwnership && subject === 'ownership-test' ||
        kind === 'removed recipient' && subject === 'assistant-sales-assistant') {
      throw new Error('private-service-canary');
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(failed);
  const before = await nats.store.head();
  await expect(reassign()).rejects.toThrow(/^Routine reassignment refused$/u);
  expect(await nats.store.head()).toBe(before);
}
it.each(['removed admin', 'demoted admin', 'demoted admin with failed ownership',
  'removed recipient', 'unapplied receipt'])(
  'hides an existing receipt and keeps saved removal through dependency failure: %s', privateRetry);

async function recovery() {
  const append = nats.store.append.bind(nats.store);
  async function lost(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lost);
  await expect(reassign()).rejects.toThrow(/^Routine reassignment unavailable$/u);
  await applySaved();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  const before = await nats.store.head();
  expect(await reassign()).toMatchObject({ status: 'confirmed',
    position: await nats.store.head('routine-orders') });
  for (const change of [{ ownerId: 'carol' }, { expectedPosition: 0 },
    { expectedDefinitionRevision: 2 }, { expectedScheduleRevision: 2 },
    { expectedControlRevision: 2 }, { changeId: 'orders:other', ownerId: 'carol' }]) {
    await expect(reassign('admin', { ...input, ...change }))
      .rejects.toThrow(/^Routine reassignment conflict$/u);
  }
  expect(await nats.store.head()).toBe(before);
  expect(await rows()).toHaveLength(2);
}
it('recovers a lost reply after duplicate expiry and restart, but conflicts on changed intent', recovery);

async function recoveryAfterRetirement() {
  const append = nats.store.append.bind(nats.store);
  async function lost(change: AppendCommand): Promise<never> {
    await append(change);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lost);
  await expect(reassign()).rejects.toThrow(/^Routine reassignment unavailable$/u);
  await applySaved();
  const reassignedRows = await rows();
  const reassigned = reassignedRows.at(-1)!;
  expect(reassigned.event.type).toBe('routine.reassigned');
  const originalReceipt = { status: 'confirmed', changeId: input.changeId,
    eventId: reassigned.event.id, position: reassigned.sequence };
  const retirement = { changeId: 'orders:retire', routineId: 'orders',
    expectedPosition: reassigned.sequence, expectedDefinitionRevision: 2,
    expectedScheduleRevision: 1, expectedControlRevision: 2 };
  await expect(retireRoutine(nats.store, binding, 'bob', retirement))
    .resolves.toMatchObject({ status: 'confirmed', changeId: 'orders:retire' });
  await applySaved();
  const before = await nats.store.head();
  const retiredRows = await rows();
  expect(retiredRows.at(-1)!.event.type).toBe('routine.retired');
  expect(await reassign()).toEqual(originalReceipt);
  expect(await nats.store.head()).toBe(before);
  expect(await rows()).toHaveLength(3);
}
it('recovers the original lost reassignment receipt after the new owner retires the routine',
  recoveryAfterRetirement);

async function writeWindow(kind: string) {
  const read = nats.store.readStream.bind(nats.store);
  const append = nats.store.append.bind(nats.store);
  const now = performance.now.bind(performance);
  let elapsed = 0;
  function clock() { return now() + elapsed; }
  async function* slowHistory(subject: string, from?: number, deadline?: number) {
    yield* read(subject, from, deadline);
    if (subject === 'routine-orders') elapsed += 3000;
  }
  async function publish(change: AppendCommand) {
    expect(change.deadline! - clock()).toBeLessThanOrEqual(2000);
    if (kind === 'expired') elapsed += 2001;
    if (kind === 'demoted') await changeMember();
    if (kind === 'recipient removed') await changeMember('bob', 'member.removed');
    if (kind === 'unrelated activity') {
      await nats.seed([event('chat', 'conversation-other', 'message.posted'),
        event('upload', 'conversation-other', 'file.uploaded')]);
    }
    return append(change);
  }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  vi.spyOn(nats.store, 'readStream').mockImplementation(slowHistory);
  vi.spyOn(nats.store, 'append').mockImplementationOnce(publish);
  if (kind === 'slow history' || kind === 'unrelated activity') {
    await expect(reassign()).resolves.toMatchObject({ status: 'confirmed' });
  } else {
    await expect(reassign()).rejects.toThrow();
    expect(await nats.store.head('routine-orders')).toBe(input.expectedPosition);
  }
}
it.each(['slow history', 'unrelated activity', 'expired', 'demoted', 'recipient removed'])(
  'keeps the original small-stream write limit: %s', writeWindow);

async function replay() {
  const storage = await database('pg');
  try {
    await saveRoutine('routine.resumed');
    await saveRoutine('routine.due');
    await saveRoutine('routine.run_finished');
    await saveRoutine('routine.paused');
    const logger = createLogger('reassign-test', { level: 'silent' });
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(routines);
    await runner.run(routines);
    const before = await storage.db.query('SELECT * FROM routine_occurrences');
    expect(before.rows[0]?.['data']).toMatchObject({ due: { rootId: 'root',
      definition: { ownerId: 'alice', payingGroupId: 'sales' } } });
    await apply([record('chat', 'conversation-chat', 'conversation.created',
      { conversationId: 'chat', assistantId: 'sales-assistant', createdBy: 'alice',
        mode: 'agent_session', payingGroupId: 'sales' })]);
    const charge = record('settled', 'budget-test', 'budget.settled',
      { reservationId: 'old-call', permitId: 'old-permit', settledCents: 1234 });
    const reserved = record('reserved', 'budget-test', 'budget.reserved',
      { reservationId: 'old-call', permitId: 'old-permit', rootId: 'root', amountCents: 1300,
        payingGroupId: 'sales', assistantId: 'sales-assistant' });
    await nats.seed([reserved, charge]);
    const budgetPosition = await nats.store.head('budget-test');
    const global = await nats.store.head();
    await reassign();
    await applySaved();
    await runner.run(routines);
    expect((await storage.db.query('SELECT * FROM routine_occurrences')).rows).toEqual(before.rows);
    const current = await storage.db.query('SELECT state FROM routines');
    expect(current.rows[0]?.['state']).toMatchObject({ status: 'paused', executionAvailable: false,
      definition: { definition: { ownerId: 'bob' } } });
    const auth = memberAuthorisation(binding, nats.store);
    for (const memberId of ['bob', 'admin']) {
      expect((await auth.conversation(memberId, 'chat', 'read')).allowed).toBe(false);
    }
    expect((await auth.conversation('alice', 'chat', 'read')).allowed).toBe(true);
    expect(await nats.store.head('budget-test')).toBe(budgetPosition);
    const append = vi.spyOn(nats.store, 'append');
    const options = { verifyAgainst: binding };
    expect((await rebuildMembers(fga.apiUrl, 'test', nats.reader, options)).verified).toBe(true);
    const verification = { verify: true };
    expect((await rebuildRoutineProjection(storage.db, nats.reader, logger, verification)).verified)
      .toBe(true);
    expect((await storage.db.query('SELECT state FROM routines')).rows).toEqual(current.rows);
    expect(append).not.toHaveBeenCalled();
    expect(await nats.store.head()).toBe(global + 1);
  } finally {
    await storage.close();
  }
}
it('applies and cold-replays the saved command without changing completed runs or starting work', replay);

async function competingEditors() {
  const alternative = { ...input, changeId: 'orders:other', ownerId: 'carol' };
  const results = await Promise.allSettled([reassign(), reassign('admin', alternative)]);
  function succeeded(result: PromiseSettledResult<unknown>) { return result.status === 'fulfilled'; }
  expect(results.filter(succeeded)).toHaveLength(1);
  const saved = await rows();
  expect(saved).toHaveLength(2);
  await applySaved();
  let stale = alternative;
  if (saved.at(-1)!.event.commandId === alternative.changeId) stale = input;
  await expect(reassign('admin', stale)).rejects.toThrow(/^Routine reassignment conflict$/u);
}
it('lets only one of two editors save their reviewed owner', competingEditors);
