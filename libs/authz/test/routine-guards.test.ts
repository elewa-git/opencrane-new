import { afterEach, expect, it, vi } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import { checkRoutine } from '../src/routines.ts';
import { supersededEvent } from '../src/backfill.ts';
import { objectId, TupleClient, type Tuple } from '../src/client.ts';
import { history, joinedMember, routine } from './routine-fixture.ts';

const binding = { apiUrl: 'http://127.0.0.1:1', silo: 'test',
  storeId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  authorizationModelId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
const allowed = { allowed: true, status: 'ok' as const };
const refused = { allowed: false, status: 'ok' as const };
const unavailable = { allowed: false, status: 'unavailable' as const };

function restore() {
  vi.restoreAllMocks();
}
afterEach(restore);

function access() {
  const events = [routine('routine.created'), joinedMember('alice')];
  const store = history(events);
  const client = new TupleClient(binding);
  const check = vi.spyOn(client, 'check').mockResolvedValue(allowed);
  async function read(memberId = 'alice') {
    return checkRoutine(binding, client, store, memberId, 'orders', 'read_metadata');
  }
  return { events, store, client, check, read };
}

async function missingStore() {
  const context = access();
  expect(await context.read()).toEqual(allowed);
  expect(await checkRoutine(binding, context.client, undefined, 'alice', 'orders', 'manage'))
    .toEqual(refused);
}
it('refuses access without saved history even when every permission check allows it', missingStore);

async function noModernCreation() {
  const context = access();
  const created = routine('routine.created');
  const legacy = { ...created, id: 'legacy', data: { routineId: 'orders',
    assistantId: 'assistant', schedule: '* * * * *', createdBy: 'alice' } };
  const updated = { ...created, id: 'modern-update', type: 'routine.updated' };
  context.events.splice(0, 1, legacy, updated);
  expect(await context.read()).toEqual(refused);
  context.events.splice(0, 2, created);
  expect(await context.read()).toEqual(allowed);
}
it('refuses a legacy routine with a modern definition but no modern creation', noModernCreation);

async function removedWithStalePermissions() {
  const context = access();
  expect(await context.read()).toEqual(allowed);
  context.events.push(event('removed', 'member-alice', 'member.removed'));
  expect(await context.read()).toEqual(refused);
}
it('requires saved active membership even when receipts and stale FGA permissions allow',
  removedWithStalePermissions);

const historySubjects = ['routine-orders', 'member-alice', 'ownership-test'];
async function unavailableHistory(subject: string) {
  const context = access();
  const read = context.store.readStream;
  async function* fail(requested: string, fromSequence = 1, deadline = Infinity) {
    if (requested === subject) {
      throw new Error('private history connection details');
    }
    yield* read(requested, fromSequence, deadline);
  }
  context.store.readStream = fail;
  expect(await context.read()).toEqual(unavailable);
}
it.each(historySubjects)('refuses unavailable %s history without error details', unavailableHistory);

async function historyDeadline(subject: string) {
  const context = access();
  const read = context.store.readStream;
  vi.spyOn(performance, 'now').mockReturnValue(500);
  async function* delayed(requested: string, fromSequence = 1, deadline = Infinity) {
    if (requested === subject) {
      // Model a source that finishes just after its caller's ten-second deadline.
      if (10_501 >= deadline) {
        throw new Error('History deadline exceeded');
      }
    }
    yield* read(requested, fromSequence, deadline);
  }
  context.store.readStream = delayed;
  expect(await context.read()).toEqual(unavailable);
}
it.each(historySubjects)('bounds slow %s history with its own deadline', historyDeadline);

const mismatches = [
  { subject: 'member-alice', field: 'subject' },
  { subject: 'member-alice', field: 'silo' },
  { subject: 'ownership-test', field: 'subject' },
  { subject: 'ownership-test', field: 'silo' },
];
async function wrongHistory({ subject, field }: typeof mismatches[number]) {
  const context = access();
  const seed = event('seed', 'ownership-test', 'ownership.seeded');
  seed.data = { ownerIds: ['alice'] };
  context.events.push(seed);
  expect(await context.read()).toEqual(allowed);
  const read = context.store.readStream;
  async function* mismatched(requested: string, fromSequence = 1, deadline = Infinity) {
    for await (const row of read(requested, fromSequence, deadline)) {
      if (requested === subject) {
        yield { ...row, event: { ...row.event, [field]: 'foreign' } };
      } else {
        yield row;
      }
    }
  }
  context.store.readStream = mismatched;
  expect(await context.read()).toEqual(unavailable);
}
it.each(mismatches)('refuses $subject history with a different $field', wrongHistory);

async function exactAccessReceipts() {
  const context = access();
  const seed = event('seed', 'ownership-test', 'ownership.seeded');
  seed.data = { ownerIds: ['other'] };
  const appointment = event('appointment', 'ownership-test', 'ownership.transferred');
  appointment.data = { memberId: 'alice', transferredBy: 'other' };
  const unrelated = { ...appointment, id: 'other-appointment',
    data: { memberId: 'bob', transferredBy: 'other' } };
  const unsupported = { ...joinedMember('alice'), id: 'unsupported', type: 'member.invited' };
  context.events.push(seed, appointment, unrelated, unsupported);
  const applied = new Set(['routine.created', 'joined-alice', 'seed', 'appointment']);
  function check(tuple: Tuple) {
    if (tuple.relation === 'applied') {
      let present = false;
      for (const id of applied) {
        present ||= tuple.object === objectId('projection_event', 'test', id);
      }
      if (!present) {
        return Promise.resolve(refused);
      }
    }
    return Promise.resolve(allowed);
  }
  context.check.mockImplementation(check);
  expect(await context.read()).toEqual(allowed);
  for (const id of ['seed', 'appointment']) {
    applied.delete(id);
    expect(await context.read()).toEqual(refused);
    applied.add(id);
    expect(await context.read()).toEqual(allowed);
  }
}
it('requires seed and target ownership receipts but ignores other members and unsupported events',
  exactAccessReceipts);

async function invalidMemberData(data: unknown) {
  const context = access();
  context.events.push({ ...joinedMember('alice'), id: 'invalid', data });
  expect(await context.read()).toEqual(unavailable);
}
it.each([null, 7])('refuses non-object member history: %s', invalidMemberData);

async function sanitisedReply(relation: string) {
  const context = access();
  context.events.push(joinedMember('admin'));
  function check(tuple: Tuple) {
    if (tuple.relation === relation) {
      return Promise.resolve({ ...unavailable, error: new Error('private upstream body') });
    }
    return Promise.resolve(allowed);
  }
  context.check.mockImplementation(check);
  expect(await context.read('admin')).toEqual(unavailable);
}
it.each(['applied', 'admin', 'read_metadata'])(
  'returns only allowed and status when the %s check fails', sanitisedReply);

async function applied() {
  await Promise.resolve();
  return true;
}

async function backfillFilters() {
  const created = routine('routine.created');
  const reassigned = routine('routine.reassigned', 'bob');
  const retired = routine('routine.retired');
  const legacy = { ...retired, data: { routineId: 'orders', retiredBy: 'alice' } };
  const paused = { ...retired, type: 'routine.paused' };
  const updated = { ...created, id: 'updated', type: 'routine.updated' };
  for (const later of [legacy, paused, updated]) {
    expect(await supersededEvent(history([created, later]), created, applied)).toBe(false);
  }
  const legacyCreated = { ...created, data: { routineId: 'orders', assistantId: 'assistant',
    schedule: '* * * * *', createdBy: 'alice' } };
  expect(await supersededEvent(history([legacyCreated, retired]), legacyCreated, applied))
    .toBe(false);
  for (const later of [reassigned, retired]) {
    expect(await supersededEvent(history([created, later]), created, applied)).toBe(true);
  }
}
it('lets only later modern ownership events supersede routine permission jobs', backfillFilters);
