import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { effectResolvedDataSchema, getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, envelope, history, priceTableId, readEffectChange,
  resolveEffect } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { IntegrationOptions } from '../src/integrations/routes.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let options: IntegrationOptions;
let app: ReturnType<typeof buildServer>;
let actor: BudgetActor;
let permitId: string;
let foreignPermit: string;
let saved: EventEnvelope;
let position: number;
const noCalls = vi.fn(noExternalCalls);
function noExternalCalls(): Promise<never> {
  throw new Error('Receipt reads must not call a provider or tool');
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function appendMember(id: string, role: string) {
  const data = { memberId: id, role, email: `${id}@example.test`, displayName: id };
  const joined = envelope('test', `member-${id}`, 'member.joined', data);
  await nats.seed([joined]);
  await memberAuthorisation(options.binding).handler.handle(joined, pgDb(dbs.queue));
}
async function initialise() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  options = { silo: 'test', binding, store: nats.store,
    feed: { memberId }, catalogue: { rows: noCalls, tools: noCalls } };
  await appendMember('owner', 'owner');
  await appendMember('admin', 'admin');
  await appendMember('member', 'member');
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(20000, 20000, 'group');
  const call = { model: 'gpt-6-astra', priceTableId, computerId: 'private-computer',
    assistantId: 'private-assistant', requesterId: 'owner', conversationId: 'private-chat',
    turnId: 'private-turn', threadId: 'private-thread', payingGroupId: 'group',
    contextDigest: '0'.repeat(64) };
  permitId = await actor.reserve(call, 1000);
  await actor.effect(permitId);
  const foreignActor = new BudgetActor(nats.store, 'other');
  await foreignActor.start(20000, 20000, 'group');
  foreignPermit = await foreignActor.reserve(call, 1000);
  app = buildServer(config, { integrations: options });
}
async function close() {
  vi.restoreAllMocks();
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
function request(changeRef: string | undefined, sub = 'owner', permit = permitId,
  server = app, orgId = 'org-acme') {
  const session = { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  let url = `/api/org/effects/${permit}`;
  if (changeRef !== undefined) url += `/changes/${changeRef}`;
  return server.inject({ method: 'GET', url, headers });
}
function expectedReceipt() {
  return { status: 'recorded', receipt: { changeRef: saved.commandId, eventId: saved.id,
    position, time: saved.time, resolvedBy: saved.principal!.id,
    outcome: 'settled', settledCents: 600 } };
}
async function detailReceipt(server = app) {
  const before = await nats.store.head();
  const state = structuredClone(actor.state);
  const response = await request(undefined, 'owner', permitId, server);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const detail = response.json<Record<string, unknown>>();
  expect(detail['resolutionReceipt']).toEqual(expectedReceipt().receipt);
  expect(detail['resolution']).toMatchObject({ outcome: 'settled', settledCents: 600 });
  expect(detail['csrf']).toEqual(expect.any(String));
  expect(await nats.store.head()).toBe(before);
  expect(actor.state).toEqual(state);
  expect(noCalls).not.toHaveBeenCalled();
  return detail;
}
beforeAll(initialise, 120000);
afterAll(close);

async function doesNotInventReceipt() {
  const response = await request(undefined);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ resolution: null, resolutionReceipt: null });
}
it('shows no receipt before any resolution is saved', doesNotInventReceipt);

async function recoversOnlySavedCommand() {
  const expectedSequence = await nats.store.head(`effect-${permitId}`);
  const first = { commandId: 'first', expectedSequence, outcome: 'settled', settledCents: 600,
    evidence: [{ kind: 'provider_receipt', reference: 'private-evidence-first',
      digest: 'a'.repeat(64), amountCents: 600 }] };
  const second = { ...first, commandId: 'second', evidence: [{ ...first.evidence[0]!,
    reference: 'private-evidence-second' }] };
  const append = nats.store.append.bind(nats.store);
  async function loseCommittedReply(input: Parameters<typeof append>[0]) {
    const result = await append(input);
    if (input.event && result.status === 'appended') throw new Error('Lost committed reply');
    return result;
  }
  const interrupted = vi.spyOn(nats.store, 'append').mockImplementation(loseCommittedReply);
  const attempts = [resolveEffect(nats.store, 'test', permitId, 'owner', first),
    resolveEffect(nats.store, 'test', permitId, 'admin', second)];
  await Promise.allSettled(attempts);
  interrupted.mockRestore();
  const rows = await history(nats.store, `effect-${permitId}`, 'test');
  function isResolution(row: (typeof rows)[number]) {
    return row.event.type === 'effect.resolved';
  }
  const resolutions = rows.filter(isResolution);
  expect(resolutions).toHaveLength(1);
  saved = resolutions[0]!.event;
  position = resolutions[0]!.sequence;
  const missing = saved.commandId === 'first' ? 'second' : 'first';
  const before = await nats.store.head();
  const state = structuredClone(actor.state);
  const response = await request(saved.commandId);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual(expectedReceipt());
  await detailReceipt();
  const absent = await request(missing);
  expect(absent.statusCode).toBe(404);
  expect(absent.json()).toEqual({ status: 'not_found' });
  expect(await nats.store.head()).toBe(before);
  expect(actor.state).toEqual(state);
  expect(noCalls).not.toHaveBeenCalled();

  await actor.effect(permitId, undefined, 'error');
  const observed = { permitId, computerId: 'private-computer', tool: 'private-tool',
    destination: 'private-destination', outcome: 'success', costCents: 600 };
  const observation = envelope('test', `effect-${permitId}`, 'effect.observed', observed);
  await nats.seed([observation]);
  await waitForDuplicateWindow(nats);
  actor = new BudgetActor(nats.store, 'test');
  await actor.start();
  const restarted = await request(saved.commandId, 'admin');
  expect(restarted.json()).toEqual(expectedReceipt());
  await detailReceipt();
  const replay = buildServer(config, { integrations: { ...options, store: nats.reader } });
  try {
    await detailReceipt(replay);
    expect((await request(saved.commandId, 'owner', permitId, replay)).json())
      .toEqual(expectedReceipt());
  } finally {
    await replay.close();
  }
  const original = saved.commandId === 'first' ? first : second;
  const resolver = saved.principal!.id;
  expect((await resolveEffect(nats.store, 'test', permitId, resolver, original)).status)
    .toBe('appended');
  const changed = { ...original, evidence: [{ ...original.evidence[0]!, reference: 'changed' }] };
  expect((await resolveEffect(nats.store, 'test', permitId, resolver, changed)).status)
    .toBe('conflict');
  const other = resolver === 'owner' ? 'admin' : 'owner';
  expect((await resolveEffect(nats.store, 'test', permitId, other, original)).status)
    .toBe('conflict');
}
it('recovers only the saved resolution after a race, lost reply, expiry, restart and replay',
  recoversOnlySavedCommand, 60000);

async function refusesInvalidRecord(kind: string) {
  const permit = `invalid-${kind}`;
  const data = { ...effectResolvedDataSchema.parse(saved.data), permitId: permit,
    reservationId: permit };
  const record = { ...saved, id: permit, subject: `effect-${permit}`, data };
  if (kind === 'principal') record.principal = { kind: 'system', id: data.resolvedBy };
  if (kind === 'actor') record.principal = { kind: 'human', id: 'forged' };
  if (kind === 'resolver') record.data.resolvedBy = 'forged';
  if (kind === 'source') record.source = 'untrusted';
  if (kind === 'permit') record.data.permitId = 'other';
  if (kind === 'reservation') record.data.reservationId = 'other';
  if (kind === 'silo') record.silo = 'other';
  if (kind === 'type') {
    record.type = 'effect.uncertain';
    const uncertain: EventEnvelope = { ...record,
      data: { permitId: permit, computerId: 'private', reason: 'missing_usage' } };
    await nats.seed([uncertain]);
  } else {
    await nats.seed([record]);
  }
  const before = await nats.store.head();
  const response = await request(saved.commandId, 'owner', permit);
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(await nats.store.head()).toBe(before);
}
it.each(['principal', 'actor', 'resolver', 'source', 'permit', 'reservation', 'silo', 'type'])(
  'does not confirm an invalid saved %s', refusesInvalidRecord);

async function refusesCaller(sub: string) {
  const response = await request(saved.commandId, sub);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({ status: 'refused' });
}
it.each(['member', 'missing-member'])('discloses no receipt to %s', refusesCaller);

async function refusesForeignAndInvalid() {
  const foreign = await request(saved.commandId, 'owner', permitId, app, 'other');
  expect(foreign.statusCode).toBe(403);
  const mismatch = buildServer(config, { integrations: { ...options, silo: 'other' } });
  try {
    expect((await request(saved.commandId, 'owner', permitId, mismatch)).statusCode).toBe(403);
  } finally {
    await mismatch.close();
  }
  expect((await request(saved.commandId, 'owner', 'wrong-permit')).json())
    .toEqual({ status: 'not_found' });
  const invalidIds = [{ value: 'bad%2Aid', status: 400 }, { value: 'x'.repeat(201), status: 414 }];
  for (const bad of invalidIds) {
    expect((await request(bad.value)).statusCode).toBe(bad.status);
    expect((await request(saved.commandId, 'owner', bad.value)).statusCode).toBe(bad.status);
  }
}
it('refuses foreign sessions, silo mismatches and malformed ids without matching other permits',
  refusesForeignAndInvalid);

async function checksAccessAfterLoading(kind: string, failed: boolean) {
  const sub = `${kind}-${String(failed)}`;
  await appendMember(sub, 'admin');
  const read = nats.store.readStream.bind(nats.store);
  async function* changeDuringRead(...args: Parameters<typeof read>) {
    const [subject, , deadline] = args;
    expect(subject).not.toBe('budget-test');
    expect(subject).not.toContain('conversation-');
    yield* read(...args);
    if (subject !== `effect-${permitId}`) return;
    expect(deadline).toBeLessThanOrEqual(performance.now() + 10000);
    expect(deadline).toBeGreaterThan(performance.now());
    let change: EventEnvelope;
    if (kind === 'remove') {
      change = envelope('test', `member-${sub}`, 'member.removed',
        { memberId: sub, removedBy: 'owner' });
    } else {
      const newRole = kind === 'demote' ? 'member' : 'admin';
      change = envelope('test', `member-${sub}`, 'member.role_changed',
        { memberId: sub, previousRole: 'admin', newRole, changedBy: 'owner' });
    }
    await nats.seed([change]);
    if (failed) throw new Error('Private history failure canary');
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(changeDuringRead);
  try {
    const response = await request(saved.commandId, sub);
    // Leave OpenFGA unchanged: events must refuse demotion/removal, and exact receipts must apply.
    expect(response.statusCode).toBe(kind === 'unapplied' ? 503 : 403);
    const status = kind === 'unapplied' ? 'unavailable' : 'refused';
    expect(response.json()).toEqual({ status });
    const memberReads = reads.mock.calls.filter(isMemberRead);
    expect(memberReads).toHaveLength(1);
  } finally {
    reads.mockRestore();
  }
}
function isMemberRead(args: Parameters<typeof nats.store.readStream>) {
  return args[0].startsWith('member-');
}
it.each([['remove', false], ['demote', false], ['unapplied', false],
  ['remove', true], ['demote', true], ['unapplied', true]] as const)(
  'checks %s after history, including failed=%s', checksAccessAfterLoading);

async function permissionFailure(kind: string, detail: boolean) {
  const auth = memberAuthorisation(options.binding);
  const permission = kind === 'denied'
    ? { status: 'ok' as const, allowed: false }
    : { status: 'unavailable' as const, allowed: false as const,
      error: new Error('IAM failure canary') };
  const check = vi.spyOn(auth, 'check').mockResolvedValue(permission);
  try {
    const response = await request(detail ? undefined : saved.commandId!);
    expect(response.statusCode).toBe(kind === 'denied' ? 403 : 503);
    const status = kind === 'denied' ? 'refused' : 'unavailable';
    expect(response.json()).toEqual({ status });
    expect(check).toHaveBeenCalledExactlyOnceWith('owner', 'admin');
  } finally {
    check.mockRestore();
  }
}
it.each([['denied', false], ['unavailable', false],
  ['denied', true], ['unavailable', true]] as const)(
  'refuses independently %s IAM permission, detail=%s', permissionFailure);

async function boundsHistoryWithoutWriteChecks() {
  const read = nats.store.readStream.bind(nats.store);
  async function* slow(...args: Parameters<typeof read>) {
    if (args[0] === `effect-${permitId}`) await delay(2200);
    yield* read(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const head = vi.spyOn(nats.store, 'head');
  const append = vi.spyOn(nats.store, 'append');
  try {
    expect((await request(saved.commandId)).json()).toEqual(expectedReceipt());
    expect(reads.mock.calls.map(readSubject))
      .toEqual([`effect-${permitId}`, 'member-owner', 'ownership-test']);
    expect(head).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(noCalls).not.toHaveBeenCalled();
    expect(await readEffectChange(nats.reader, 'test', permitId, saved.commandId!))
      .toEqual(expectedReceipt().receipt);
  } finally {
    reads.mockRestore();
    head.mockRestore();
    append.mockRestore();
  }
}
function readSubject(args: Parameters<typeof nats.store.readStream>) {
  return args[0];
}
it('allows slow history under its own deadline, reads only access streams afterwards and writes nothing',
  boundsHistoryWithoutWriteChecks);

async function expiresHistory(detail: boolean) {
  const read = nats.store.readStream.bind(nats.store);
  const now = vi.spyOn(performance, 'now');
  async function* expired(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === `effect-${permitId}`) now.mockReturnValue(args[2]! + 1);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(expired);
  try {
    const response = await request(detail ? undefined : saved.commandId!);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(reads.mock.calls.filter(isMemberRead)).toHaveLength(1);
  } finally {
    reads.mockRestore();
    now.mockRestore();
  }
}
it.each([false, true])('refuses expired history and still checks access, detail=%s', expiresHistory);

async function readsRecordedZeroWithoutRelease() {
  const permit = await actor.reserve(actor.state.reservations[0]!.call, 1000);
  const evidence = [{ kind: 'dispatch_record', reference: 'private-proof',
    digest: 'a'.repeat(64), notDispatched: true }];
  const data = { permitId: permit, reservationId: permit, resolvedBy: 'owner',
    outcome: 'released', settledCents: 0, evidence };
  const record = { ...envelope('test', `effect-${permit}`, 'effect.resolved', data),
    source: 'opencrane-server', principal: { kind: 'human' as const, id: 'owner' } };
  await nats.seed([record]);
  const before = await nats.store.head();
  const state = structuredClone(actor.state);
  const response = await request(record.commandId, 'admin', permit);
  expect(response.json()).toEqual({ status: 'recorded', receipt: {
    changeRef: record.commandId, eventId: record.id, position: before,
    time: record.time, resolvedBy: 'owner', outcome: 'released', settledCents: 0,
  } });
  const detail = await request(undefined, 'admin', permit);
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({
    settledCents: null, reservedCents: 1000, state: 'resolution_pending',
    resolutionReceipt: response.json<{ receipt: unknown }>().receipt,
  });
  expect(await nats.store.head()).toBe(before);
  expect(actor.state).toEqual(state);
  expect(noCalls).not.toHaveBeenCalled();
}
it('returns recorded zero cents without claiming or applying a release', readsRecordedZeroWithoutRelease);

async function keepsReceiptBesideConflictingMoney() {
  const data = { permitId, computerId: 'private-computer', tool: 'private-tool',
    destination: 'private-destination', outcome: 'success', costCents: 700 };
  const observation = envelope('test', `effect-${permitId}`, 'effect.observed', data);
  await nats.seed([observation]);
  await actor.settleRecorded(permitId, saved.id);
  const before = await nats.store.head();
  const detail = await detailReceipt();
  expect(detail).toMatchObject({ settledCents: 700, reservedCents: 1000,
    state: 'outcome_unknown', conflict: true });
  const replay = buildServer(config, { integrations: { ...options, store: nats.reader } });
  try {
    const replayed = await detailReceipt(replay);
    const expected = { ...detail, csrf: replayed['csrf'] };
    expect(replayed).toEqual(expected);
  } finally {
    await replay.close();
  }
  expect(await nats.store.head()).toBe(before);
}
it('keeps the saved amount separate from conflicting settlement and retains the hold',
  keepsReceiptBesideConflictingMoney);

async function refusesInvalidDetail(kind: string) {
  const read = nats.store.readStream.bind(nats.store);
  async function* invalid(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (args[0] !== `effect-${permitId}` || row.event.id !== saved.id) {
        yield row;
        continue;
      }
      const event = structuredClone(row.event);
      const data = effectResolvedDataSchema.parse(event.data);
      event.data = data;
      if (kind === 'subject') event.subject = 'effect-foreign';
      if (kind === 'silo') event.silo = 'other';
      if (kind === 'permit') data.permitId = 'other';
      if (kind === 'reservation') data.reservationId = 'other';
      if (kind === 'source') event.source = 'untrusted';
      if (kind === 'principal') event.principal = { kind: 'system', id: data.resolvedBy };
      if (kind === 'resolver') data.resolvedBy = 'forged';
      if (kind === 'cents') data.settledCents = 0.5;
      if (kind === 'time') event.time = 'not-a-time';
      if (kind === 'change') delete event.commandId;
      yield { ...row, event };
      if (kind === 'duplicate') yield row;
      if (kind === 'later') yield { ...row, event: { ...event, id: 'later', commandId: 'later' } };
      if (kind === 'reused-change') {
        const uncertain = { permitId, computerId: 'private', reason: 'missing_usage' };
        yield { ...row, event: { ...event, type: 'effect.uncertain', data: uncertain } };
      }
    }
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(invalid);
  try {
    const before = await nats.store.head();
    const response = await request(undefined);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(reads.mock.calls.filter(isMemberRead)).toHaveLength(1);
    expect(await nats.store.head()).toBe(before);
  } finally {
    reads.mockRestore();
  }
}
it.each(['subject', 'silo', 'permit', 'reservation', 'source', 'principal', 'resolver',
  'cents', 'time', 'change', 'duplicate', 'later', 'reused-change'])(
  'refuses detail with invalid or ambiguous resolution %s', refusesInvalidDetail);

async function checksDetailAccess(kind: string, failed: boolean) {
  for (const permit of [permitId, 'missing', foreignPermit]) {
    const sub = `detail-${kind}-${String(failed)}-${permit}`;
    await appendMember(sub, 'admin');
    const read = nats.store.readStream.bind(nats.store);
    async function* changeDuringLoad(...args: Parameters<typeof read>) {
      yield* read(...args);
      if (args[0] !== 'budget-test') return;
      let change: EventEnvelope;
      if (kind === 'remove') {
        change = envelope('test', `member-${sub}`, 'member.removed',
          { memberId: sub, removedBy: 'owner' });
      } else {
        const newRole = kind === 'demote' ? 'member' : 'admin';
        change = envelope('test', `member-${sub}`, 'member.role_changed',
          { memberId: sub, previousRole: 'admin', newRole, changedBy: 'owner' });
      }
      await nats.seed([change]);
      if (failed) throw new Error('Private history failure canary');
    }
    const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(changeDuringLoad);
    try {
      const response = await request(undefined, sub, permit);
      expect(response.statusCode).toBe(kind === 'unapplied' ? 503 : 403);
      const status = kind === 'unapplied' ? 'unavailable' : 'refused';
      expect(response.json()).toEqual({ status });
      expect(reads.mock.calls.filter(isMemberRead)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  }
}
it.each([['remove', false], ['demote', false], ['unapplied', false],
  ['remove', true], ['demote', true], ['unapplied', true]] as const)(
  'checks detail access for existing, missing and foreign ids: %s, failed=%s', checksDetailAccess);

async function permitsSlowDetailWithChatActivity() {
  const read = nats.store.readStream.bind(nats.store);
  async function* slow(...args: Parameters<typeof read>) {
    if (args[0] === `effect-${permitId}`) await delay(2200);
    yield* read(...args);
    if (args[0] !== 'member-owner') return;
    const data = getEventDefinition('agent.message_delta')!.example;
    const change = envelope('test', 'conversation-private-chat', 'agent.message_delta', data);
    await nats.seed([change]);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(slow);
  const append = vi.spyOn(nats.store, 'append');
  try {
    const response = await request(undefined);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ resolutionReceipt: expectedReceipt().receipt });
    expect(reads.mock.calls.map(readSubject)).toEqual([
      'budget-test', `effect-${permitId}`, 'member-owner', 'ownership-test',
    ]);
    expect(append).not.toHaveBeenCalled();
    expect(noCalls).not.toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    append.mockRestore();
  }
}
it('loads slow detail before one access check and permits unrelated chat activity',
  permitsSlowDetailWithChatActivity);

async function refusesFailedDetail() {
  const read = nats.store.readStream.bind(nats.store);
  async function* failed(...args: Parameters<typeof read>) {
    if (args[0] === 'budget-test') throw new Error('Private outage canary');
    yield* read(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(failed);
  try {
    const response = await request(undefined);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(reads.mock.calls.filter(isMemberRead)).toHaveLength(1);
  } finally {
    reads.mockRestore();
  }
}
it('returns a fixed detail outage after checking authorised access once', refusesFailedDetail);

async function recoversAfterServiceRestart() {
  await app.close();
  await nats.stop();
  await nats.restart();
  app = buildServer(config, { integrations: options });
  const before = await nats.store.head();
  expect((await request(saved.commandId)).json()).toEqual(expectedReceipt());
  await detailReceipt();
  const missing = saved.commandId === 'first' ? 'second' : 'first';
  expect((await request(missing)).json()).toEqual({ status: 'not_found' });
  expect(await nats.store.head()).toBe(before);
  const resolver = saved.principal!.id;
  const demoted = envelope('test', `member-${resolver}`, 'member.role_changed', {
    memberId: resolver, previousRole: resolver, newRole: 'member', changedBy: 'owner',
  });
  await nats.seed([demoted]);
  await refusesCaller(resolver);
}
// Restart last: the NATS fixture cleans up a process restarted inside a test when that test ends.
it('recovers the same original receipt after restarting NATS and the server', recoversAfterServiceRestart);
