import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { failingPublishStore, natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { applyMcpInstance, mcpInstanceId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { registerMcpInstanceWorkerRoutes } from '../src/integrations/instance-worker.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let app: ReturnType<typeof buildServer>;
let workers: ReturnType<typeof registerMcpInstanceWorkerRoutes>;
let failures: Awaited<ReturnType<typeof failingPublishStore>>;
let counter = 0;
async function initialise() {
  nats = await natsFixture();
  app = buildServer(testAuthConfig());
  failures = await failingPublishStore(nats.connection);
  nats.store = failures.store;
  workers = registerMcpInstanceWorkerRoutes(app, nats.store, 'test');
}
beforeAll(initialise, 30_000);
async function close() {
  await app?.close();
  await nats?.close();
}
afterAll(close);

async function start(siloId = 'test') {
  counter += 1;
  const identity = { siloId, userId: 'alice', profileId: `profile-${counter}`,
    serverId: 'server-id', startupAccessGeneration: 1 };
  const instanceId = mcpInstanceId(identity);
  const requestedAt = new Date().toISOString();
  const deadline = new Date(Date.parse(requestedAt) + 20_000).toISOString();
  const data = { ...identity, instanceId, connectionId: 'connection-id',
    imageDigest: 'a'.repeat(64), installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64),
    workloadSpecDigest: 'c'.repeat(64), runGeneration: 1, changeRef: `start-${counter}`,
    requestedAt, deadline };
  const event = envelope(siloId, `mcp-instance-${instanceId}`,
    'mcp.instance_start_requested', data);
  const result = await nats.store.append({ event, expectedSequence: 0 });
  if (result.status !== 'appended') throw new Error('Start fixture failed');
  const registration = { ...identity, instanceId, runGeneration: 1,
    startChangeRef: data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: data.workloadSpecDigest, expectedSequence: result.sequence,
    workerId: `worker-${counter}` };
  const payload = { changeRef: `observation-${counter}`, expectedSequence: result.sequence,
    state: 'starting' };
  return { event, data, registration, payload, sequence: result.sequence };
}
function observationUrl(instanceId: string) {
  return `/internal/mcp/instances/${instanceId}/observations`;
}
function observe(instanceId: string, authorization: string | undefined, payload: object) {
  const headers = authorization ? { authorization } : {};
  const request = { method: 'POST' as const, url: observationUrl(instanceId), headers, payload };
  return app.inject(request);
}

async function savesOnlyAnObservation() {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const request = { method: 'POST' as const,
    url: observationUrl(fixture.registration.instanceId),
    headers: { authorization: worker.authorization }, payload: fixture.payload };
  const saved = await app.inject(request);
  expect(saved.statusCode).toBe(200);
  expect(saved.headers['cache-control']).toBe('no-store');
  expect(saved.json()).toMatchObject({ status: 'applied', runGeneration: 1 });
  const retry = await app.inject(request);
  expect(retry.json()).toEqual(saved.json());
  const changed = { ...fixture.payload, state: 'failed' };
  const changedRequest = { ...request, payload: changed };
  const refused = await app.inject(changedRequest);
  expect(refused.statusCode).toBe(409);
  const rows = await history(nats.store, fixture.event.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]?.event.type).toBe('mcp.instance_observed');
  expect(rows[1]?.event.principal).toEqual({ kind: 'system', id: fixture.registration.workerId });
  expect(rows[1]?.event.data).toMatchObject({ podUid: 'original-pod', state: 'starting' });
  expect(saved.body).not.toContain(worker.authorization);
}
it('authenticates an observation without starting or releasing, and checks changed retries',
  savesOnlyAnObservation);

const foreignCases = ['silo', 'user', 'profile', 'server', 'renamed profile',
  'revision', 'run', 'start', 'spec'] as const;
async function refusesRegistration(field: (typeof foreignCases)[number]) {
  const fixture = await start(field === 'silo' ? 'foreign' : 'test');
  const registration = { ...fixture.registration };
  if (field === 'user') registration.userId = 'bob';
  if (field === 'profile') registration.profileId = 'foreign';
  if (field === 'server') registration.serverId = 'foreign';
  if (field === 'renamed profile') registration.profileId = 'My renamed profile';
  if (field === 'revision') registration.expectedSequence = 0;
  if (field === 'run') registration.runGeneration = 2;
  if (field === 'start') registration.startChangeRef = 'foreign';
  if (field === 'spec') registration.workloadSpecDigest = 'd'.repeat(64);
  await expect(workers.register(registration)).rejects.toThrow();
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it.each(foreignCases)('refuses worker registration with a foreign or stale %s',
  refusesRegistration);

async function refusesUntrustedObservations() {
  const fixture = await start();
  const other = await start();
  const worker = await workers.register(fixture.registration);
  for (const authorization of [undefined, 'Bearer foreign']) {
    const refused = await observe(fixture.registration.instanceId, authorization, fixture.payload);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['cache-control']).toBe('no-store');
  }
  const foreign = await observe(other.registration.instanceId, worker.authorization, other.payload);
  expect(foreign.statusCode).toBe(403);
  for (const extra of [{ userId: 'bob' }, { siloId: 'foreign' }, { profileId: 'foreign' },
    { serverId: 'foreign' }, { profileId: 'My renamed profile' },
    { runGeneration: 2 }, { podUid: 'replacement' },
    { state: 'callable' }, { state: 'failed', reason: 'not_found' }]) {
    const payload = { ...fixture.payload, ...extra };
    const refused = await observe(fixture.registration.instanceId, worker.authorization, payload);
    expect(refused.statusCode).toBe(400);
  }
  const newer = envelope('test', fixture.event.subject, 'mcp.instance_observed', {
    instanceId: fixture.registration.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' });
  const result = await nats.store.append({ event: newer, expectedSequence: fixture.sequence });
  const stale = await observe(fixture.registration.instanceId, worker.authorization, fixture.payload);
  expect(stale.statusCode).toBe(409);
  expect(result.status).toBe('appended');
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(worker.expiresAt + 1);
    const expired = await observe(fixture.registration.instanceId,
      worker.authorization, fixture.payload);
    expect(expired.statusCode).toBe(403);
  } finally {
    clock.mockRestore();
  }
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(2);
}
it('refuses foreign, expired and stale workers and caller-selected identities over HTTP',
  refusesUntrustedObservations);

async function missingRemainsUnknown() {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const payload = { ...fixture.payload, state: 'unknown', reason: 'not_found' };
  const response = await observe(fixture.registration.instanceId, worker.authorization, payload);
  expect(response.statusCode).toBe(200);
  const rows = await history(nats.store, fixture.event.subject, 'test');
  expect(rows[1]?.event.data).toMatchObject({ state: 'unknown', reason: 'not_found' });
  expect(rows).toHaveLength(2);
}
it('records a missing workload as unknown rather than a terminal failure', missingRemainsUnknown);

async function refusesReplacedOrOldRunWorkers() {
  const fixture = await start();
  const old = await workers.register(fixture.registration);
  const worker = await workers.register(fixture.registration);
  const retired = await observe(fixture.registration.instanceId, old.authorization, fixture.payload);
  expect(retired.statusCode).toBe(403);
  const starting = await observe(fixture.registration.instanceId,
    worker.authorization, fixture.payload);
  expect(starting.statusCode).toBe(200);
  const observation = { instanceId: fixture.registration.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'absent' };
  const stopData = { instanceId: fixture.registration.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, changeRef: `stop-${counter}`,
    expectedSequence: starting.json<{ sequence: number }>().sequence,
    requestedBy: 'alice', reason: 'owner_stop' };
  const stop = { ...fixture.event, id: stopData.changeRef, commandId: stopData.changeRef,
    type: 'mcp.instance_stop_requested', data: stopData,
    principal: { kind: 'human' as const, id: 'alice' } };
  const stopped = await nats.store.append({ event: stop, expectedSequence: stopData.expectedSequence });
  if (stopped.status !== 'appended') throw new Error('Stop fixture failed');
  const absent = envelope('test', fixture.event.subject, 'mcp.instance_observed', observation);
  const absence = await nats.store.append({ event: absent, expectedSequence: stopped.sequence });
  if (absence.status !== 'appended') throw new Error('Absence fixture failed');
  const next = envelope('test', fixture.event.subject, 'mcp.instance_start_requested',
    { ...fixture.data, runGeneration: 2, changeRef: `next-${counter}` });
  const newer = await nats.store.append({ event: next, expectedSequence: absence.sequence });
  if (newer.status !== 'appended') throw new Error('Next run fixture failed');
  const payload = { ...fixture.payload, changeRef: `late-${counter}`,
    expectedSequence: newer.sequence };
  const refused = await observe(fixture.registration.instanceId, worker.authorization, payload);
  expect(refused.statusCode).toBe(409);
  expect(await nats.store.head(fixture.event.subject)).toBe(newer.sequence);
  const replacement = { ...fixture.registration, runGeneration: 2,
    startChangeRef: `next-${counter}`, expectedSequence: newer.sequence, podUid: 'next-pod' };
  await expect(workers.register(replacement)).resolves.toHaveProperty('authorization');
}
it('retires a replaced worker and refuses an old run even with its latest revision',
  refusesReplacedOrOldRunWorkers);

async function refusesRegistrationAfterPodBinding() {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const response = await observe(fixture.registration.instanceId,
    worker.authorization, fixture.payload);
  expect(response.statusCode).toBe(200);
  const registration = { ...fixture.registration, podUid: 'foreign-pod',
    expectedSequence: response.json<{ sequence: number }>().sequence };
  await expect(workers.register(registration)).rejects.toThrow();
}
it('refuses a foreign Pod once the saved observation binds the original Pod',
  refusesRegistrationAfterPodBinding);

async function retiresWorkerDuringHistoryRead() {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const originalRead = nats.store.readStream.bind(nats.store);
  async function* replaceDuringRead(subject: string, fromSequence?: number, deadline?: number) {
    for await (const row of originalRead(subject, fromSequence, deadline)) {
      yield row;
    }
    if (subject === fixture.event.subject) {
      read.mockRestore();
      await workers.register(fixture.registration);
    }
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(replaceDuringRead);
  try {
    const response = await observe(fixture.registration.instanceId,
      worker.authorization, fixture.payload);
    expect(response.statusCode).toBe(409);
  } finally {
    read.mockRestore();
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('refuses a worker retired while its observation reads saved history',
  retiresWorkerDuringHistoryRead);

async function refusesChangedConcurrentRetry() {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const changed = { ...fixture.payload, state: 'failed' };
  const requests = [
    observe(fixture.registration.instanceId, worker.authorization, fixture.payload),
    observe(fixture.registration.instanceId, worker.authorization, changed),
  ];
  const responses = await Promise.all(requests);
  const codes: number[] = [];
  for (const response of responses) codes.push(response.statusCode);
  codes.sort();
  expect(codes).toEqual([200, 409]);
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(2);
}
it('saves one observation and refuses a concurrent changed retry with the same id',
  refusesChangedConcurrentRetry);

async function expectUnchangedInstance(fixture: Awaited<ReturnType<typeof start>>) {
  const rows = await history(nats.store, fixture.event.subject, 'test');
  expect(rows).toHaveLength(1);
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
  const originalState = applyMcpInstance(undefined, fixture.event, fixture.sequence);
  let currentState;
  for (const row of rows) {
    currentState = applyMcpInstance(currentState, row.event, row.sequence);
  }
  expect(currentState).toEqual(originalState);
}

async function expiresDuringPublishRetry(stage: 'publish' | 'backoff') {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const clock = vi.spyOn(Date, 'now');
  // Leave ten milliseconds of permission when append starts, regardless of history read speed.
  clock.mockReturnValue(worker.expiresAt - 10);
  async function failFirstPublish() {
    if (stage === 'publish') {
      await delay(30);
    }
  }
  failures.failNextPublish(failFirstPublish);
  try {
    const response = await observe(fixture.registration.instanceId,
      worker.authorization, fixture.payload);
    expect.soft(response.statusCode).toBe(503);
    expect.soft(failures.publishAttempts()).toBe(1);
  } finally {
    clock.mockRestore();
  }
  await expectUnchangedInstance(fixture);
}
it.each(['publish', 'backoff'] as const)(
  'stops publishing when permission expires during the failed first %s', expiresDuringPublishRetry);

async function replacesDuringPublishRetry(stage: 'publish' | 'backoff') {
  const fixture = await start();
  const worker = await workers.register(fixture.registration);
  const failed = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  async function failFirstPublish() {
    failed.resolve();
    if (stage === 'publish') {
      await replaced.promise;
    }
  }
  failures.failNextPublish(failFirstPublish);
  try {
    const pending = observe(fixture.registration.instanceId, worker.authorization, fixture.payload);
    const responsePromise = pending.then();
    await failed.promise;
    await workers.register(fixture.registration);
    replaced.resolve();
    const response = await responsePromise;
    expect.soft(response.statusCode).toBe(503);
    expect.soft(failures.publishAttempts()).toBe(1);
  } finally {
    replaced.resolve();
  }
  await expectUnchangedInstance(fixture);
}
it.each(['publish', 'backoff'] as const)(
  'stops publishing when a worker is replaced during the failed first %s',
  replacesDuringPublishRetry);

async function retainsOnlyDigestsAndDropsExpiredLeases() {
  const fixture = await start();
  const storageApp = buildServer(testAuthConfig());
  const storageWorkers = registerMcpInstanceWorkerRoutes(storageApp, nats.store, 'test');
  const retained: Map<unknown, unknown>[] = [];
  const originalSet = Map.prototype.set;
  function captureLease(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof value === 'object' && value !== null && 'worker' in value) {
      retained.push(this);
    }
    return originalSet.call(this, key, value);
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const writes = vi.spyOn(Map.prototype, 'set');
  writes.mockImplementation(captureLease);
  try {
    const worker = await storageWorkers.register(fixture.registration);
    writes.mockRestore();
    expect(retained).toHaveLength(1);
    const leases = retained[0];
    expect(leases).toBeDefined();
    if (!leases) throw new Error('Lease storage was not captured');
    const saved = JSON.stringify(Array.from(leases.entries()));
    expect.soft(saved).not.toContain(worker.authorization.slice('Bearer '.length));
    for (const key of leases.keys()) {
      expect.soft(key).toMatch(/^[a-f0-9]{64}$/u);
    }
    await vi.advanceTimersByTimeAsync(30_001);
    expect.soft(leases.size).toBe(0);
  } finally {
    writes.mockRestore();
    vi.useRealTimers();
    await storageApp.close();
  }
}
it('keeps only credential digests and removes expired leases without another request',
  retainsOnlyDigestsAndDropsExpiredLeases);
