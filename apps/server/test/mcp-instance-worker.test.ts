import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { mcpInstanceId } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { registerMcpInstanceWorkerRoutes } from '../src/integrations/instance-worker.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let app: ReturnType<typeof buildServer>;
let workers: ReturnType<typeof registerMcpInstanceWorkerRoutes>;
let counter = 0;
async function initialise() {
  nats = await natsFixture();
  app = buildServer(testAuthConfig());
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
  const refused = await app.inject({ ...request, payload: changed });
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
  const url = observationUrl(fixture.registration.instanceId);
  for (const authorization of [undefined, 'Bearer foreign']) {
    const headers = authorization ? { authorization } : {};
    const refused = await app.inject({ method: 'POST', url, headers, payload: fixture.payload });
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['cache-control']).toBe('no-store');
  }
  const headers = { authorization: worker.authorization };
  const foreign = await app.inject({ method: 'POST',
    url: observationUrl(other.registration.instanceId), headers, payload: other.payload });
  expect(foreign.statusCode).toBe(403);
  for (const extra of [{ userId: 'bob' }, { siloId: 'foreign' }, { profileId: 'foreign' },
    { serverId: 'foreign' }, { runGeneration: 2 }, { podUid: 'replacement' },
    { state: 'callable' }, { state: 'failed', reason: 'not_found' }]) {
    const payload = { ...fixture.payload, ...extra };
    const refused = await app.inject({ method: 'POST', url, headers, payload });
    expect(refused.statusCode).toBe(400);
  }
  const newer = envelope('test', fixture.event.subject, 'mcp.instance_observed', {
    instanceId: fixture.registration.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' });
  const result = await nats.store.append({ event: newer, expectedSequence: fixture.sequence });
  const stale = await app.inject({ method: 'POST', url, headers, payload: fixture.payload });
  expect(stale.statusCode).toBe(409);
  expect(result.status).toBe('appended');
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(worker.expiresAt + 1);
    const expired = await app.inject({ method: 'POST', url, headers, payload: fixture.payload });
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
  const response = await app.inject({ method: 'POST',
    url: observationUrl(fixture.registration.instanceId),
    headers: { authorization: worker.authorization }, payload });
  expect(response.statusCode).toBe(200);
  const rows = await history(nats.store, fixture.event.subject, 'test');
  expect(rows[1]?.event.data).toMatchObject({ state: 'unknown', reason: 'not_found' });
  expect(rows).toHaveLength(2);
}
it('records a missing workload as unknown rather than a terminal failure', missingRemainsUnknown);
