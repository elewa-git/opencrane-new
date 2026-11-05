import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, type ECKeyPairOptions } from 'node:crypto';
import { z } from 'zod';
import { tokenIssuer } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { event } from '@opencrane/event-store/testing';
import { isEventStoreUnavailable } from '@opencrane/event-store';
import { foldRoutine, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, history, rootTotals } from '@opencrane/models';
import { conversationKeys, ProjectionRunner, routines } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { createLogger } from '@opencrane/observability';
import { dispatchRoutineCandidates, withRoutineLeadership }
  from '../../ops/test/support/routine-handoff.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { bridgeChannel } from '../../computer/test/server.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import * as routineSession from '../src/routine-session.ts';
import { createRoutineComposition } from '../src/routine-composition.ts';

let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let runner: ProjectionRunner;
let databaseUrl: string;
let stop: AbortController;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let keys: ReturnType<typeof conversationKeys>;
let actor: BudgetActor;
let directory: string;
let now: number;
let wake: typeof preparedComputer.wake;
let preparedComputer: Awaited<ReturnType<typeof startComputer>>;
const proposedEvent = z.object({ type: z.string() });
const frameSchema = z.record(z.string(), z.unknown());
function clock() {
  return now;
}
function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), source: 'opencrane-server', commandId: id, data };
}
function forbidden(): never {
  throw new Error('private-service-canary');
}
async function apply(events: EventEnvelope[]) {
  await nats.seed(events);
  const auth = memberAuthorisation(binding, nats.store);
  const db = { query: forbidden };
  for (const saved of events) {
    await auth.handler.handle(saved, db);
  }
}
async function setup() {
  storage = await database('pg');
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const address = new URL(process.env['PG_TEST_URL']!);
  address.pathname = `/${current.rows[0]!.name}`;
  databaseUrl = address.href;
  nats = await shortDuplicateWindowFixture();
  const logOptions = { level: 'silent' };
  const logger = createLogger('routine-handoff-test', logOptions);
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(routines);
  stop = new AbortController();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  directory = await mkdtemp('/tmp/routine-composition-');
  keys = conversationKeys(directory);
  keys.provision('test', 'routine-orders');
  now = Date.parse('2026-10-11T07:00:00Z');
  const created = routine('routine.created');
  const original = foldRoutine(undefined, created).definition!;
  const instructions = keys.encrypt('test', 'routine-orders', 'Private routine instructions');
  const definition = { ...original.definition, instructions };
  const active = { ...created, data: { ...original, definition, status: 'active' } };
  const events = [joinedMember('alice')];
  for (const group of ['sales', 'billing']) {
    const team = { teamId: group, name: group, createdBy: 'alice' };
    const membership = { teamId: group, memberId: 'alice', addedBy: 'alice' };
    const teamCreated = record(`created-${group}`, `team-${group}`, 'team.created', team);
    events.push(teamCreated);
    const memberAdded = record(`added-${group}`, `team-${group}`, 'team.member_added', membership);
    events.push(memberAdded);
  }
  const assistant = { assistantId: 'sales-assistant', kind: 'team',
    ownerId: 'billing', payingGroupId: 'sales' };
  const assistantCreated = record(
    'assistant', 'assistant-sales-assistant', 'assistant.created', assistant
  );
  events.push(assistantCreated);
  events.push(active);
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'sales-assistant']]) {
    const grant = { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind, granteeId,
      grantedBy: 'alice' };
    const grantSubject = grantStream('model', 'gpt-6.1-sol');
    const grantGiven = record(
      `grant-${granteeKind}`, grantSubject, 'grant.given', grant
    );
    events.push(grantGiven);
  }
  await apply(events);
  const computer = { assistantId: 'sales-assistant', computerId: 'computer', generation: 1 };
  const ready = record('ready', 'computer-sales-assistant', 'computer.ready', computer);
  const computerClaim = { ...computer, tokenId: 'token:fixture-computer' };
  const computerClaimed = record('claimed', 'computer-sales-assistant',
    'computer.claimed', computerClaim);
  await nats.seed([computerClaimed, ready]);
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'sales');
  preparedComputer = await startComputer();
  wake = preparedComputer.wake;
  const prepareSession = routineSession.prepareRoutineSession;
  async function projectSession(...supplied: Parameters<typeof prepareSession>) {
    const result = await prepareSession(...supplied);
    const rows = await history(nats.store, `conversation-${result.conversationId}`, 'test');
    const creation = rows[0]!.event;
    const auth = memberAuthorisation(binding, nats.store);
    const database = { query: forbidden };
    await auth.handler.handle(creation, database);
    async function applied() {
      return (await auth.checkApplied(creation.id)).allowed;
    }
    await until(applied);
    return result;
  }
  const sessionSpy = vi.spyOn(routineSession, 'prepareRoutineSession');
  sessionSpy.mockImplementation(projectSession);
}
async function startComputer() {
  const server = createServer();
  const executedThreads: string[] = [];
  const frames: Record<string, unknown>[] = [];
  let nativeStarts = 0;
  function grant() {
    return Promise.resolve();
  }
  function credential() {
    return { value: 'fixture-bridge', expiresAt: Date.now() + 120_000 };
  }
  function privateSession() {
    const lifetime = Promise.withResolvers<void>();
    let threadId: string | undefined;
    function close() {
      lifetime.resolve();
    }
    function rpc(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') {
        nativeStarts++;
        threadId = `native-${nativeStarts}`;
        expect(params).not.toHaveProperty('threadId');
      }
      if (method === 'turn/start') {
        expect(params['threadId']).toBe(threadId);
        expect(JSON.stringify(params)).toContain('Private routine instructions');
        executedThreads.push(String(threadId));
      }
      const response = { thread: { id: threadId, ephemeral: true, path: null },
        turn: { id: 'native-turn' } };
      return Promise.resolve(response);
    }
    const session = { rpc, close, closed: lifetime.promise };
    return Promise.resolve(session);
  }
  const driver = { rpc: forbidden, grant, credential, privateSession, journal: `${directory}/journal` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture unavailable');
  }
  const keyOptions: ECKeyPairOptions<'pem', 'pem'> = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } };
  const pair = generateKeyPairSync('ec', keyOptions);
  const fileOptions = { mode: 0o600 };
  await writeFile(`${directory}/signing.pem`, pair.privateKey, fileOptions);
  const tokenOptions = { privateKeyPath: `${directory}/signing.pem`,
    issuer: 'https://routine.test/' };
  const tokens = await tokenIssuer(tokenOptions);
  const connection = { computerId: 'computer', assistantId: 'sales-assistant',
    bearer: 'fixture-bridge', url: `ws://127.0.0.1:${address.port}/bridge` };
  const options = { silo: 'test', store: nats.store, keys, binding };
  const link = await connectBridge(options, connection, tokens);
  const send = link.socket.send.bind(link.socket);
  function track(bytes: Parameters<typeof send>[0]) {
    if (typeof bytes === 'string') {
      frames.push(frameSchema.parse(JSON.parse(bytes)));
    }
    send(bytes);
  }
  const sendSpy = vi.spyOn(link.socket, 'send');
  sendSpy.mockImplementation(track);
  function wake(assistantId: string) {
    expect(assistantId).toBe('sales-assistant');
    const ready = { link, generation: 1 };
    return Promise.resolve(ready);
  }
  async function close() {
    link.socket.terminate();
    await channel.close();
    await link.settled();
    server.close();
  }
  function executed() {
    return executedThreads.length === 1;
  }
  return { link, wake, close, executed, executedThreads, frames, send: track,
    get nativeStarts() {
      return nativeStarts;
    } };
}
async function cleanup() {
  vi.restoreAllMocks();
  await preparedComputer?.close();
  await fga?.close();
  await nats?.close();
  await storage?.close();
  if (directory) {
    const options = { recursive: true, force: true };
    await rm(directory, options);
  }
}
beforeEach(setup);
afterEach(cleanup);

type Lease = Parameters<Parameters<typeof withRoutineLeadership>[1]>[0];
type Options = Parameters<typeof createRoutineComposition>[0];
type Handoff = NonNullable<Parameters<typeof dispatchRoutineCandidates>[3]>;
let leaseSignal: AbortSignal;
async function dispatch(options: Options = { enabled: true }, continuation = false) {
  await runner.run(routines);
  let progress;
  const receive: Handoff = async function receive(due, lease) {
    expect(lease.signal).toBe(leaseSignal);
    async function checkCurrent(deadline: number) {
      if (lease.signal.aborted) {
        return false;
      }
      const current = await lease.checkCurrent(deadline);
      return current && !lease.signal.aborted;
    }
    const worker = { silo: 'test', binding, workerId: 'routine-worker', checkCurrent, now: clock };
    const input = { routineId: due.routineId, occurrenceId: due.occurrenceId };
    const invocation = createRoutineComposition(options, nats.store, keys, worker, input,
      actor, due.turnId);
    const result = await invocation.send(wake);
    if (result.status === 'sent') {
      await until(preparedComputer.executed);
      await preparedComputer.link.settled();
    }
    return result;
  };
  async function work(lease: Lease) {
    leaseSignal = lease.signal;
    const worker = { ...lease, silo: 'test', binding, now: clock };
    progress = await dispatchRoutineCandidates(storage.db, nats.store, worker, receive);
  }
  const leadership = { databaseUrl, silo: 'test', signal: stop.signal };
  await withRoutineLeadership(leadership, work);
  if (continuation) {
    expect(progress).toMatchObject({ examined: 1, continuation: { afterRoutineId: 'orders' } });
  }
  return progress;
}
async function projectionReaderReady() {
  try {
    await nats.reader.head();
    return true;
  } catch (error) {
    if (isEventStoreUnavailable(error)) {
      return false;
    }
    throw error;
  }
}
async function runState() {
  const rows = await history(nats.store, 'routine-orders', 'test');
  let state;
  for (const row of rows) {
    state = foldRoutine(state, row.event);
  }
  if (!state) {
    throw new Error('Fixture routine unavailable');
  }
  return state;
}
async function assertSingleRun() {
  const run = (await runState()).activeRun!;
  const subjects = [`conversation-${run.conversationId}`, 'budget-test', 'routine-orders'];
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const rows = await history(nats.store, subject, 'test');
    expect(JSON.stringify(rows)).not.toContain('Private routine instructions');
    for (const row of rows) {
      counts.set(row.event.type, (counts.get(row.event.type) ?? 0) + 1);
    }
  }
  for (const type of ['routine.due', 'conversation.created', 'message.posted',
    'budget.root_allowance_set', 'routine.run_activation_admitted']) {
    expect(counts.get(type)).toBe(1);
  }
  expect(actor.state.roots[0]).toMatchObject({ payingGroupId: 'sales', allowanceCents: 1000 });
  expect(rootTotals(actor.state, actor.state.roots[0]!.rootId)).toEqual({
    settledCents: 0, heldCents: 0, availableCents: 1000 });
  return run;
}
async function reachesNativeThread() {
  expect(await dispatch()).toMatchObject({ examined: 1 });
  await until(preparedComputer.executed);
  const original = await assertSingleRun();
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  // Wait for the separate projection connection before reading through it again.
  await until(projectionReaderReady);
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(await assertSingleRun()).toEqual(original);
  expect(preparedComputer.executedThreads).toEqual(['native-1']);
}
it('hands a checked due to its prepared thread once across duplicate delivery and restart',
  reachesNativeThread);
async function recoversLostReply() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(...args: Parameters<typeof append>): Promise<never> {
    await append(...args);
    throw new Error('private-service-canary');
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseReply);
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  const original = (await runState()).activeRun!;
  expect(preparedComputer.nativeStarts).toBe(0);
  await waitForDuplicateWindow(nats);
  await nats.stop();
  await nats.restart();
  // Wait for the separate projection connection before reading through it again.
  await until(projectionReaderReady);
  expect(await dispatch()).toMatchObject({ examined: 1 });
  await until(preparedComputer.executed);
  expect(await assertSingleRun()).toEqual(original);
  expect(original.startBy).toBe('2026-10-11T07:01:00.000Z');
}
it('recovers a lost due reply with its original identities and start deadline', recoversLostReply);
async function disabled(options: Options) {
  const forbiddenWake = vi.fn(forbidden);
  wake = forbiddenWake;
  await expect(dispatch(options)).rejects.toThrow('Routine leadership unavailable');
  expect(forbiddenWake).not.toHaveBeenCalled();
  expect(actor.state.roots).toEqual([]);
  expect(preparedComputer.frames).toEqual([]);
}
const disabledOptions = [{}, { enabled: true, replay: true }];
it.each(disabledOptions)('keeps execution disabled: %j', disabled);
async function fourteenSecondWake() {
  const created = routine('routine.created');
  const other = { ...created, id: 'second', commandId: 'second', subject: 'routine-second',
    data: { ...foldRoutine(undefined, created).definition!, routineId: 'second' } };
  await apply([other]);
  const monotonic = performance.now.bind(performance);
  function later() {
    return monotonic() + 14_000;
  }
  async function delayed(assistantId: string) {
    now += 14_000;
    const timer = vi.spyOn(performance, 'now');
    timer.mockImplementation(later);
    return preparedComputer.wake(assistantId);
  }
  wake = delayed;
  const enabled = { enabled: true };
  await dispatch(enabled, true);
  await until(preparedComputer.executed);
  await assertSingleRun();
  expect(await nats.store.head('routine-second')).toBeGreaterThan(0);
  expect(preparedComputer.nativeStarts).toBe(1);
}
it('drains a fourteen-second wake and returns before admitting another candidate',
  fourteenSecondWake);
async function cancelsWake(shutdown: boolean) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function heldWake(assistantId: string) {
    entered.resolve();
    await release.promise;
    return preparedComputer.wake(assistantId);
  }
  wake = heldWake;
  let settled = false;
  function finished() {
    settled = true;
  }
  const pending = dispatch();
  void pending.then(finished, finished);
  const rejected = expect(pending).rejects.toThrow('Routine leadership unavailable');
  await entered.promise;
  try {
    if (shutdown) {
      stop.abort();
    } else {
      await terminateLease();
    }
    function cancelled() {
      expect(leaseSignal.aborted).toBe(true);
    }
    await vi.waitFor(cancelled);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  await rejected;
  expect(preparedComputer.nativeStarts).toBe(0);
  expect(actor.state.roots).toEqual([]);
}
it.each([false, true])('drains cancelled wake before releasing leadership, shutdown=%s',
  cancelsWake);
async function terminateLease() {
  await storage.db.query(`SELECT pg_terminate_backend(pid) FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND
    classid = (hashtextextended('opencrane:projection:routine-leader:test', 0) >> 32)::int
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
}
async function losesLeadership(stage: string) {
  const append = nats.store.append.bind(nats.store);
  let reached = false;
  async function interrupt(...args: Parameters<typeof append>) {
    if (proposedEvent.parse(args[0].event).type === stage) {
      reached = true;
      await terminateLease();
    }
    return append(...args);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementation(interrupt);
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(reached).toBe(true);
  expect(preparedComputer.executedThreads).toEqual([]);
  expect((await runState()).activation).toBeNull();
}
it.each(['conversation.created', 'routine.run_activation_admitted'])(
  'refuses an old worker when its leadership session ends before %s', losesLeadership);
async function refusesAfterWake(kind: string) {
  async function changed(assistantId: string) {
    if (kind === 'expired') {
      now += 60_001;
    } else if (kind === 'removed') {
      const data = { memberId: 'alice', removedBy: 'admin' };
      const removed = record('removed', 'member-alice', 'member.removed', data);
      await nats.seed([removed]);
    } else {
      await nats.seed([routine(`routine.${kind}`)]);
    }
    return preparedComputer.wake(assistantId);
  }
  wake = changed;
  await expect(dispatch()).rejects.toThrow('Routine leadership unavailable');
  expect(preparedComputer.executedThreads).toEqual([]);
  expect(actor.state.roots).toEqual([]);
}
it.each(['expired', 'removed', 'paused', 'retired'])(
  'refuses %s work after wake without claiming completed progress', refusesAfterWake);
async function ignoresNonDue(kind: string) {
  if (kind === 'future') {
    now -= 1;
  } else if (kind === 'missed') {
    now += 60_001;
  } else {
    await nats.seed([routine('routine.paused')]);
  }
  wake = vi.fn(forbidden);
  expect(await dispatch()).toMatchObject({ examined: 1 });
  expect(wake).not.toHaveBeenCalled();
  expect((await runState()).activeRun).toBeNull();
}
it.each(['future', 'missed', 'inactive'])('does not hand off a %s candidate', ignoresNonDue);
