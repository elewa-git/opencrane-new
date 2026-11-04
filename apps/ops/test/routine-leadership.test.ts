import { expect, it, onTestFinished, vi } from 'vitest';
import { connectProjectionDb, type Db } from '@opencrane/projections';
import { withRoutineLeadership } from '../src/routine-leadership.ts';

import * as projections from '@opencrane/projections';
import * as models from '@opencrane/models';
import * as tools from '../../../libs/models/src/mcp-dispatch.ts';
import * as broker from '../../../libs/models/src/credential-broker.ts';
import { foldRoutine } from '@opencrane/events';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { natsFixture, event } from '@opencrane/event-store/testing';
import { openfga } from '../../../libs/authz/test/services.ts';
import { routine, joinedMember } from '../../../libs/authz/test/routine-fixture.ts';
import { claimRoutineDue } from '../src/routine-due.ts';
import { SandboxClient } from '../src/kubernetes.ts';

const databaseUrl = process.env['PG_TEST_URL']!;
type Leadership = Parameters<Parameters<typeof withRoutineLeadership>[1]>[0];

async function owner(silo = 'test') {
  const ready = Promise.withResolvers<Leadership>();
  const finish = Promise.withResolvers<void>();
  const stop = new AbortController();
  async function work(lease: Leadership) {
    ready.resolve(lease);
    await finish.promise;
  }
  const options = { databaseUrl, silo, signal: stop.signal };
  const done = withRoutineLeadership(options, work);
  void done.catch(ready.reject);
  async function close() {
    stop.abort();
    finish.resolve();
    await done.catch(ignoreError);
  }
  onTestFinished(close);
  const lease = await ready.promise;
  return { lease, close, stop, finish, done };
}

function ignoreError() {}
async function excludesOnlyItsSilo() {
  const first = await owner();
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  const other = await owner('other');
  expect(await other.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  const database = connectProjectionDb(databaseUrl, ignoreError);
  onTestFinished(database.close);
  async function budget() {
    expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  }
  await database.db.lock!('budget-leader:test', budget, { timeoutMs: 1000 });
  const entered = Promise.withResolvers<void>();
  async function replacement(lease: Leadership) {
    expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
    expect(await lease.checkCurrent(performance.now() + 2000)).toBe(true);
    entered.resolve();
  }
  const stop = new AbortController();
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  const next = withRoutineLeadership(options, replacement);
  void next.catch(entered.reject);
  async function waitingForOwner() {
    const result = await database.db.query(`SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND
      database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    expect(result.rows).toHaveLength(1);
  }
  await vi.waitFor(waitingForOwner);
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  await first.close();
  await entered.promise;
  await next;
}
it('holds one routine owner per silo independently of budget leadership', excludesOnlyItsSilo);

async function cancelsLostSession() {
  const first = await owner();
  await terminate();
  await vi.waitFor(aborted);
  function aborted() {
    expect(first.lease.signal.aborted).toBe(true);
  }
  const next = await owner();
  expect(await next.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
  await first.close();
}
it('cancels idle preparation after the held session is terminated', cancelsLostSession);

async function terminate() {
  const admin = connectProjectionDb(databaseUrl, ignoreError);
  onTestFinished(admin.close);
  await admin.db.query(`SELECT pg_terminate_backend(pid) FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND
    classid = (hashtextextended('opencrane:projection:routine-leader:test', 0) >> 32)::int
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
}

async function waitsForWork() {
  const first = await owner();
  first.stop.abort();
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
  const contender = vi.fn();
  const options = { databaseUrl, silo: 'test', signal: AbortSignal.timeout(100) };
  await expect(withRoutineLeadership(options, contender)).rejects.toThrow(
    /^Routine leadership unavailable$/u);
  expect(contender).not.toHaveBeenCalled();
  await first.close();
  const next = await owner();
  expect(await next.lease.checkCurrent(performance.now() + 2000)).toBe(true);
}
it('keeps the session until cancelled preparation has stopped', waitsForWork);

async function refusesExpiredCheck() {
  const first = await owner();
  expect(await first.lease.checkCurrent(performance.now() - 1)).toBe(false);
  const stop = new AbortController();
  stop.abort();
  const work = vi.fn();
  await expect(withRoutineLeadership({ databaseUrl, silo: 'other', signal: stop.signal }, work))
    .rejects.toThrow(/^Routine leadership unavailable$/u);
  expect(work).not.toHaveBeenCalled();
}
it('refuses expired checks and shutdown before acquisition', refusesExpiredCheck);

async function releasesThrownCallback() {
  let captured: Leadership | undefined;
  async function fail(lease: Leadership) {
    captured = lease;
    await lease.checkCurrent(performance.now() + 2000);
    throw new Error('private-service-canary');
  }
  const options = { databaseUrl, silo: 'test', signal: new AbortController().signal };
  await expect(withRoutineLeadership(options, fail)).rejects.toThrow(
    /^Routine leadership unavailable$/u);
  const next = await owner();
  expect(await next.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  expect(await captured!.checkCurrent(performance.now() + 2000)).toBe(false);
}
it('releases after a thrown callback without exposing its error', releasesThrownCallback);

function captureSession() {
  let session: Db;
  const connect = projections.connectProjectionDb;
  function observed(...args: Parameters<typeof connect>) {
    const database = connect(...args);
    const lock = database.db.lock!.bind(database.db);
    async function observe<Result>(name: string, work: (db: Db) => Promise<Result>,
      options?: { timeoutMs: number; signal?: AbortSignal }) {
      function held(locked: Db) {
        session = locked;
        return work(locked);
      }
      return lock(name, held, options);
    }
    database.db.lock = observe;
    return database;
  }
  vi.spyOn(projections, 'connectProjectionDb').mockImplementationOnce(observed);
  function restore() {
    vi.restoreAllMocks();
  }
  onTestFinished(restore);
  return function current() {
    return session;
  };
}
async function drainsCheck(expire: boolean) {
  const session = captureSession();
  const first = await owner();
  const query = session().query.bind(session());
  const deadline = performance.now() + (expire ? 40 : 2000);
  async function slow(_sql: string, _parameters?: unknown[], options?: { deadline: number }) {
    expect(options!.deadline).toBeLessThanOrEqual(deadline);
    return query('SELECT pg_sleep(0.15)', [], options);
  }
  vi.spyOn(session(), 'query').mockImplementationOnce(slow);
  const checking = first.lease.checkCurrent(deadline);
  if (!expire) first.finish.resolve();
  expect(await checking).toBe(false);
  await first.close();
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
  const next = await owner();
  expect(await next.lease.checkCurrent(performance.now() + 2000)).toBe(true);
}
it.each([false, true])('drains a pending query on release or expiry (%s)', drainsCheck);

async function dueFixture() {
  const nats = await natsFixture();
  onTestFinished(nats.close.bind(nats));
  const fga = await openfga();
  onTestFinished(fga.close.bind(fga));
  const binding = await createStore(fga.apiUrl, 'test');
  const example = routine('routine.created');
  const saved = foldRoutine(undefined, example).definition!;
  const schedule = { frequency: 'weekly' as const, weekday: 7,
    localTime: '02:30', zone: 'Europe/Brussels' };
  const definition = { ...saved.definition, schedule };
  const next = { localDate: '2026-10-25', localTime: '02:30', zone: 'Europe/Brussels',
    at: '2026-10-25T00:30:00.000Z', offsetMinutes: 120 };
  const data = { ...saved, status: 'active', definition, next };
  const created = { ...example, data };
  const joined = joinedMember('alice');
  await nats.seed([joined, created]);
  const auth = memberAuthorisation(binding, nats.store);
  function forbidden(): never {
    throw new Error('Forbidden effect');
  }
  const db = { query: forbidden };
  await auth.handler.handle(joined, db);
  await auth.handler.handle(created, db);
  const effects = [vi.spyOn(SandboxClient.prototype, 'mode').mockImplementation(forbidden),
    vi.spyOn(models, 'startGateway').mockImplementation(forbidden),
    vi.spyOn(tools, 'mcpDispatch').mockImplementation(forbidden),
    vi.spyOn(broker, 'credentialBroker').mockImplementation(forbidden)];
  function checkEffects() {
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
  onTestFinished(checkEffects);
  function now() {
    return Date.parse(next.at);
  }
  function claim(lease: Leadership) {
    const worker = { silo: 'test', binding, now, checkCurrent: lease.checkCurrent,
      signal: lease.signal };
    const input = { routineId: 'orders', expectedPosition: 2, localDate: next.localDate,
      definitionRevision: 1, scheduleRevision: 1, controlRevision: 1 };
    return claimRoutineDue(nats.store, worker, input);
  }
  return { nats, claim };
}

async function cancelsDue() {
  const { nats, claim } = await dueFixture();
  const first = await owner();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  function releaseWait() {
    resume.resolve();
  }
  onTestFinished(releaseWait);
  const read = nats.store.readStream.bind(nats.store);
  async function* prepare(...args: Parameters<typeof read>) {
    waiting.resolve();
    await resume.promise;
    yield* read(...args);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementationOnce(prepare);
  const append = vi.spyOn(nats.store, 'append');
  const pending = expect(claim(first.lease)).rejects.toThrow(/^Routine due refused$/u);
  await waiting.promise;
  await terminate();
  function cancelled() {
    expect(first.lease.signal.aborted).toBe(true);
  }
  await vi.waitFor(cancelled);
  const replacement = await owner();
  resume.resolve();
  await pending;
  expect(append).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(2);
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
  const receipt = await claim(replacement.lease);
  expect(receipt.executionAvailable).toBe(false);
  expect(await nats.store.head()).toBe(3);
}
it('withholds append and receipt after session loss during due preparation', cancelsDue);

async function cancelsDuringAppendAccess(afterAccess: boolean) {
  const { nats, claim } = await dueFixture();
  const first = await owner();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  function releaseWait() {
    resume.resolve();
  }
  onTestFinished(releaseWait);
  const append = nats.store.append.bind(nats.store);
  const readHead = nats.store.head.bind(nats.store);
  let appending = false;
  async function observedAppend(...args: Parameters<typeof append>) {
    appending = true;
    const change = args[0];
    async function checkAccess() {
      await change.checkAccess!();
      if (afterAccess) {
        waiting.resolve();
        await resume.promise;
      }
    }
    const observedChange = { ...change, checkAccess };
    return append(observedChange);
  }
  async function pauseMemberRead(...args: Parameters<typeof readHead>) {
    if (!afterAccess && appending && args[0] === 'member-alice') {
      waiting.resolve();
      await resume.promise;
    }
    return readHead(...args);
  }
  const appendSpy = vi.spyOn(nats.store, 'append');
  appendSpy.mockImplementationOnce(observedAppend);
  const headSpy = vi.spyOn(nats.store, 'head');
  headSpy.mockImplementation(pauseMemberRead);
  const pending = expect(claim(first.lease)).rejects.toThrow(/^Routine due refused$/u);
  await waiting.promise;
  await terminate();
  function cancelled() {
    expect(first.lease.signal.aborted).toBe(true);
  }
  await vi.waitFor(cancelled);
  const replacement = await owner();
  expect(await replacement.lease.checkCurrent(performance.now() + 2000)).toBe(true);
  resume.resolve();
  await pending;
  expect(await nats.store.head()).toBe(2);
  const receipt = await claim(replacement.lease);
  expect(receipt.executionAvailable).toBe(false);
  expect(receipt.position).toBe(3);
  expect(await nats.store.head()).toBe(3);
}
it.each([false, true])(
  'saves no due after takeover during append (access check finished: %s)', cancelsDuringAppendAccess);

async function recoversDue() {
  const { nats, claim } = await dueFixture();
  const first = await owner();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>): Promise<never> {
    await append(...args);
    throw new Error('private-service-canary');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  await expect(claim(first.lease)).rejects.toThrow(/^Routine due unavailable$/u);
  const original = await claim(first.lease);
  expect(original).toMatchObject({ startBy: '2026-10-25T00:31:00.000Z',
    position: 3, executionAvailable: false });
  await first.close();
  const replacement = await owner();
  await expect(claim(first.lease)).rejects.toThrow(/^Routine due refused$/u);
  expect(await claim(replacement.lease)).toEqual(original);
  expect(await nats.store.head()).toBe(3);
  await nats.seed([event('removed', 'member-alice', 'member.removed')]);
  await expect(claim(replacement.lease)).rejects.toThrow(/^Routine due refused$/u);
  expect(await nats.store.head()).toBe(4);
}
it('recovers one due after a lost reply and still checks the owner and old session', recoversDue);

async function refusesFailedQuery() {
  const session = captureSession();
  const first = await owner();
  vi.spyOn(session(), 'query').mockRejectedValueOnce(new Error('private-query-canary'));
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
  expect(first.lease.signal.aborted).toBe(true);
  expect(await first.lease.checkCurrent(performance.now() + 2000)).toBe(false);
}
it('cancels after a failed leadership query without leaking its error', refusesFailedQuery);

async function withholdsSavedReceipt() {
  const { nats, claim } = await dueFixture();
  const first = await owner();
  const read = nats.store.readEvent.bind(nats.store);
  async function loseSession(...args: Parameters<typeof read>) {
    await terminate();
    return read(...args);
  }
  vi.spyOn(nats.store, 'readEvent').mockImplementationOnce(loseSession);
  await expect(claim(first.lease)).rejects.toThrow(/^Routine due refused$/u);
  expect(await nats.store.head()).toBe(3);
  const replacement = await owner();
  expect(await claim(replacement.lease)).toMatchObject({ position: 3, executionAvailable: false });
}
it('withholds a saved receipt when the session closes after append', withholdsSavedReceipt);

async function boundsCancellation() {
  const stop = new AbortController();
  const ready = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let captured: Leadership | undefined;
  function stopped() {
    cancelled.resolve();
  }
  async function prepare(lease: Leadership) {
    captured = lease;
    lease.signal.addEventListener('abort', stopped, { once: true });
    ready.resolve();
    await cancelled.promise;
    expect(await lease.checkCurrent(performance.now() + 2000)).toBe(false);
  }
  const options = { databaseUrl, silo: 'test', signal: stop.signal };
  const pending = withRoutineLeadership(options, prepare);
  void pending.catch(ready.reject);
  await ready.promise;
  const started = performance.now();
  stop.abort();
  await pending;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(captured!.signal.aborted).toBe(true);
  const next = await owner();
  expect(await next.lease.checkCurrent(performance.now() + 2000)).toBe(true);
}
it('finishes cooperative shutdown within the bounded check time', boundsCancellation);

async function holdsUntilCheckReturns() {
  const session = captureSession();
  const first = await owner();
  const query = session().query.bind(session());
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  function releaseWait() {
    resume.resolve();
  }
  onTestFinished(releaseWait);
  async function pendingResult(sql: string, parameters?: unknown[], options?: { deadline: number }) {
    const result = await query(sql, parameters, options);
    ready.resolve();
    await resume.promise;
    return result;
  }
  vi.spyOn(session(), 'query').mockImplementationOnce(pendingResult);
  const checking = first.lease.checkCurrent(performance.now() + 2000);
  await ready.promise;
  first.finish.resolve();
  const contender = vi.fn();
  const options = { databaseUrl, silo: 'test', signal: AbortSignal.timeout(100) };
  await expect(withRoutineLeadership(options, contender)).rejects.toThrow(
    /^Routine leadership unavailable$/u);
  expect(contender).not.toHaveBeenCalled();
  resume.resolve();
  expect(await checking).toBe(false);
  await expect(first.done).resolves.toBeUndefined();
}
it('holds the lock until an outstanding check returns after SQL has finished', holdsUntilCheckReturns);
