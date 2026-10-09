import { afterEach, expect, it, vi } from 'vitest';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import type { Query } from '@opencrane/projections';
import { readActiveIdentity } from '../src/members/admission.ts';

const issuer = 'https://idp.example.test';
const account = 'person';
const now = new Date('2026-10-01T12:00:00Z');
type CandidateRow = { sequence: string | number; member_id: string | null };
type IdentityStore = Pick<EventStore, 'head' | 'readStream'>;

function restoreMocks() {
  vi.restoreAllMocks();
}
afterEach(restoreMocks);

function joined(sequence: number, memberId = 'person'): StoredEvent {
  const data = { memberId, displayName: 'Person', email: 'person@example.test',
    role: 'member', identity: { issuer, sub: account } };
  const record = { ...event(`join-${sequence}`, `member-${memberId}`, 'member.joined'),
    silo: 'acme', principal: { kind: 'human', id: account }, data };
  return { sequence, event: record };
}

function projection(rows: CandidateRow[]): Query {
  async function query<Row extends Record<string, unknown>>() {
    return { rows: rows as Row[] };
  }
  return { query };
}

function store(memberPosition: number, recent: StoredEvent[], candidates: StoredEvent[],
  requiredDeadline?: number): IdentityStore {
  function head() {
    return Promise.resolve(memberPosition);
  }
  async function* readStream(subject: string, _from?: number, deadline?: number) {
    if (requiredDeadline !== undefined) {
      // Refuse an unbounded read to model a stalled event-store request.
      if (deadline !== requiredDeadline) throw new Error('Missing history deadline');
    }
    if (subject === 'member-*') {
      yield* recent;
    } else {
      yield* candidates;
    }
  }
  return { head, readStream };
}

function readIdentity(source: IdentityStore, db: Query) {
  return readActiveIdentity(source, db, 'acme', issuer, account, now);
}

async function refusesInvalidCheckpoint(sequence: string | number) {
  const rows = [{ sequence, member_id: null }];
  await expect(readIdentity(store(1, [], []), projection(rows)))
    .rejects.toThrow('Identity projection unavailable');
}
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'missing'])(
  'refuses an invalid identity projection checkpoint (%s)', refusesInvalidCheckpoint);

async function refusesMissingCheckpoint() {
  await expect(readIdentity(store(0, [], []), projection([])))
    .rejects.toThrow('Identity projection unavailable');
}
it('refuses a missing members checkpoint', refusesMissingCheckpoint);

function candidateRows(count: number): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({ sequence: 1, member_id: `candidate-${index}` });
  }
  return rows;
}

async function refusesProjectedCandidateOverflow() {
  await expect(readIdentity(store(1, [], []), projection(candidateRows(101))))
    .rejects.toThrow('Identity projection unavailable');
}
it('refuses more than one hundred projected identity candidates',
  refusesProjectedCandidateOverflow);

const emptyProjection = [{ sequence: 0, member_id: null }];

async function refusesForeignRecentEvent() {
  const row = joined(1);
  const foreign = { ...row, event: { ...row.event, silo: 'other' } };
  await expect(readIdentity(store(1, [foreign], []), projection(emptyProjection)))
    .rejects.toThrow('Identity history unavailable');
}
it('refuses an unapplied member event from another silo', refusesForeignRecentEvent);

function unrelatedRows(count: number): StoredEvent[] {
  const rows: StoredEvent[] = [];
  for (let index = 1; index <= count; index += 1) {
    const row = joined(index, 'unrelated');
    row.event.data = { memberId: 'unrelated' };
    rows.push(row);
  }
  return rows;
}

async function refusesRecentEventOverflow() {
  const recent = unrelatedRows(10_001);
  await expect(readIdentity(store(10_001, recent, []), projection(emptyProjection)))
    .rejects.toThrow('Identity history unavailable');
}
it('refuses more than ten thousand unapplied member events', refusesRecentEventOverflow);

async function refusesCombinedCandidateOverflow() {
  const recent = [joined(2, 'new-candidate')];
  await expect(readIdentity(store(2, recent, []), projection(candidateRows(100))))
    .rejects.toThrow('Too many matching members');
}
it('counts projected and unapplied identity candidates together',
  refusesCombinedCandidateOverflow);

const projectedPerson = [{ sequence: 1, member_id: 'person' }];

async function refusesInvalidCandidate(kind: string) {
  const row = joined(1);
  if (kind === 'silo') row.event.silo = 'other';
  if (kind === 'subject') row.event.subject = 'member-other';
  await expect(readIdentity(store(1, [], [row]), projection(projectedPerson)))
    .rejects.toThrow('Identity history unavailable');
}
it.each(['silo', 'subject'])('refuses a candidate with a different %s',
  refusesInvalidCandidate);

async function refusesCandidateHistoryOverflow() {
  const candidates = unrelatedRows(10_001);
  for (const row of candidates) row.event.subject = 'member-person';
  await expect(readIdentity(store(10_001, [], candidates),
    projection([{ sequence: 10_001, member_id: 'person' }])))
    .rejects.toThrow('Identity history unavailable');
}
it('refuses more than ten thousand events in one candidate history',
  refusesCandidateHistoryOverflow);

async function refusesConflictingBindings() {
  const first = joined(1);
  const second = joined(2);
  second.event.data = { identity: { issuer, sub: 'someone-else' } };
  await expect(readIdentity(store(2, [], [first, second]),
    projection([{ sequence: 2, member_id: 'person' }])))
    .rejects.toThrow('Identity history mismatch');
}
it('refuses a candidate bound to both this account and another account',
  refusesConflictingBindings);

async function excludesLaterRecentEvents() {
  const recent = unrelatedRows(1);
  recent.push(joined(2));
  const result = await readIdentity(store(1, recent, [joined(2)]), projection(emptyProjection));
  expect(result).toEqual({ active: false, memberSequence: 1 });
}
it('ignores member events saved after the captured member position', excludesLaterRecentEvents);

async function excludesLaterCandidateEvents() {
  const removal = { ...event('remove-person', 'member-person', 'member.removed'),
    silo: 'acme', data: { memberId: 'person', removedBy: 'admin' } };
  const candidates = [joined(1), { sequence: 2, event: removal }];
  const result = await readIdentity(store(1, [], candidates), projection(projectedPerson));
  expect(result).toEqual({ active: true, memberSequence: 1 });
}
it('ignores a candidate removal saved after the captured member position',
  excludesLaterCandidateEvents);

function fixedPerformanceTime() {
  return 100;
}

async function boundsEventReads(kind: string) {
  vi.spyOn(performance, 'now').mockImplementation(fixedPerformanceTime);
  const rows = [joined(1)];
  const db = projection(kind === 'recent' ? emptyProjection : projectedPerson);
  const recent = kind === 'recent' ? rows : [];
  const result = await readIdentity(store(1, recent, rows, 10_100), db);
  expect(result).toEqual({ active: true, memberSequence: 1 });
}
it.each(['recent', 'candidate'])('bounds %s reads with the ten-second deadline', boundsEventReads);
