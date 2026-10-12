import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { mcpInstanceId, pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let counter = 0;

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  const authorisation = memberAuthorisation(binding);
  for (const memberId of ['alice', 'bob']) {
    const data = { memberId, role: 'member', email: `${memberId}@example.test`,
      displayName: memberId };
    const joined = envelope('test', `member-${memberId}`, 'member.joined', data);
    await nats.store.append({ event: joined, expectedSequence: 0 });
    await authorisation.handler.handle(joined, pgDb(storage.queue));
  }
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(['alice', 'bob'].includes(subject) ? subject : undefined);
  }
  const mcpInstances = { silo: 'test', store: nats.store, binding,
    db: pgDb(storage.queue), feed: { memberId } };
  app = buildServer(config, { mcpInstances });
}
beforeAll(initialise, 120_000);

async function close() {
  await app?.close();
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);

function headers(memberId = 'alice', orgId = 'org-test') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: memberId, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
}

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
  const reference = { instanceId, profileId: identity.profileId, serverId: identity.serverId };
  const stop = { changeRef: `stop-${counter}`, expectedSequence: result.sequence };
  return { reference, data, event, sequence: result.sequence, stop };
}

function instanceUrl(reference: Awaited<ReturnType<typeof start>>['reference'], action = '') {
  const profileId = encodeURIComponent(reference.profileId);
  return `/api/my/tools/${reference.serverId}/profiles/${profileId}/instance${action}` +
    `?instanceId=${reference.instanceId}`;
}

function changeUrl(reference: Awaited<ReturnType<typeof start>>['reference'], changeRef: string) {
  const query = new URLSearchParams(reference);
  return `/api/my/tools/changes/${changeRef}?${query.toString()}`;
}

async function readsWithoutEffects() {
  const fixture = await start();
  const append = vi.spyOn(nats.store, 'append');
  try {
    const status = await app.inject({ url: instanceUrl(fixture.reference), headers: headers() });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.json()).toMatchObject({ state: 'waking', runGeneration: 1,
      sequence: fixture.sequence, changeRef: fixture.data.changeRef });
    expect(status.body).not.toMatch(/podUid|imageDigest|workloadSpecDigest|connectionId/u);
    const original = await app.inject({ url: changeUrl(fixture.reference, fixture.data.changeRef),
      headers: headers() });
    expect(original.statusCode).toBe(200);
    expect(original.json()).toMatchObject({ status: 'applied', sequence: fixture.sequence });
    const missing = await app.inject({ url: changeUrl(fixture.reference, 'missing'),
      headers: headers() });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ status: 'unknown' });
    const absent = { ...fixture.reference, instanceId: 'f'.repeat(64) };
    const unknown = await app.inject({ url: changeUrl(absent, 'missing'), headers: headers() });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ status: 'unknown' });
    expect(append).not.toHaveBeenCalled();
  } finally {
    append.mockRestore();
  }
}
it('reads safe status and original intent without waking, releasing or making 404 terminal',
  readsWithoutEffects);

const foreignCases = ['silo', 'user', 'profile', 'server', 'renamed profile'] as const;
async function refusesForeign(field: (typeof foreignCases)[number]) {
  const fixture = await start(field === 'silo' ? 'foreign' : 'test');
  const reference = { ...fixture.reference };
  if (field === 'profile') reference.profileId = 'foreign';
  if (field === 'server') reference.serverId = 'foreign';
  if (field === 'renamed profile') reference.profileId = 'My renamed profile';
  const caller = headers(field === 'user' ? 'bob' : 'alice');
  const requests = [
    { method: 'GET' as const, url: instanceUrl(reference), headers: caller },
    { method: 'GET' as const, url: changeUrl(reference, fixture.data.changeRef), headers: caller },
    { method: 'POST' as const, url: instanceUrl(reference, '/stop'), headers: caller,
      payload: fixture.stop },
  ];
  for (const request of requests) {
    const response = await app.inject(request);
    expect([400, 404]).toContain(response.statusCode);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it.each(foreignCases)('refuses a foreign %s over HTTP', refusesForeign);

async function refusesStaleAndChanged() {
  const fixture = await start();
  const url = instanceUrl(fixture.reference, '/stop');
  for (const override of [{ expectedSequence: 0 }]) {
    const payload = { ...fixture.stop, ...override };
    const response = await app.inject({ method: 'POST', url, headers: headers(), payload });
    expect(response.statusCode).toBe(409);
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
  const request = { method: 'POST' as const, url, headers: headers(), payload: fixture.stop };
  const saved = await app.inject(request);
  expect(saved.statusCode).toBe(200);
  const retry = await app.inject(request);
  expect(retry.json()).toEqual(saved.json());
  const changed = { ...fixture.stop, expectedSequence: 0 };
  const conflict = await app.inject({ ...request, payload: changed });
  expect(conflict.statusCode).toBe(409);
  const rows = await history(nats.store, fixture.event.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]?.event.type).toBe('mcp.instance_stop_requested');
  expect(rows[1]?.event.principal).toEqual({ kind: 'human', id: 'alice' });
  const original = await app.inject({ url: changeUrl(fixture.reference, fixture.stop.changeRef),
    headers: headers() });
  expect(original.json()).toEqual(saved.json());
}
it('refuses stale revisions, stale runs and changed duplicate payloads over HTTP',
  refusesStaleAndChanged);

async function refusesWakeAndForgedInput() {
  const fixture = await start();
  const wake = await app.inject({ method: 'POST', url: instanceUrl(fixture.reference, '/wake'),
    headers: headers(), payload: fixture.stop });
  expect(wake.statusCode).toBe(409);
  expect(wake.json()).toEqual({ status: 'refused', reason: 'profile_or_admission_unavailable' });
  for (const extra of [{ userId: 'bob' }, { siloId: 'foreign' },
    { profileId: 'foreign' }, { serverId: 'foreign' }, { startupAccessGeneration: 2 },
    { runGeneration: 2 }, { action: 'wake' }]) {
    const payload = { ...fixture.stop, ...extra };
    const response = await app.inject({ method: 'POST',
      url: instanceUrl(fixture.reference, '/stop'), headers: headers(), payload });
    expect(response.statusCode).toBe(400);
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('keeps wake closed and refuses caller-selected identity or action', refusesWakeAndForgedInput);

async function refusesUntrustedSessions() {
  const fixture = await start();
  const url = instanceUrl(fixture.reference, '/stop');
  const cases = [
    { headers: {}, code: 401 },
    { headers: headers('alice', 'foreign'), code: 403 },
    { headers: headers('unmapped'), code: 403 },
    { headers: { ...headers(), origin: 'https://foreign.example' }, code: 403 },
    { headers: { cookie: headers().cookie }, code: 403 },
  ];
  for (const testCase of cases) {
    const response = await app.inject({ method: 'POST', url, headers: testCase.headers,
      payload: fixture.stop });
    expect(response.statusCode).toBe(testCase.code);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('requires a mapped member in this organisation and same-origin writes',
  refusesUntrustedSessions);

async function refusesMissingSetup() {
  const fixture = await start();
  const unavailableApp = buildServer(config);
  try {
    const response = await unavailableApp.inject({ url: instanceUrl(fixture.reference),
      headers: headers() });
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await unavailableApp.close();
  }
}
it('reports missing instance dependencies as unavailable', refusesMissingSetup);

async function retainsOriginalRun() {
  const fixture = await start();
  const observation = { instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' };
  const observed = envelope('test', fixture.event.subject, 'mcp.instance_observed', observation);
  const result = await nats.store.append({ event: observed, expectedSequence: fixture.sequence });
  if (result.status !== 'appended') throw new Error('Observation fixture failed');
  const payload = { ...fixture.stop, expectedSequence: result.sequence };
  const request = { method: 'POST' as const, url: instanceUrl(fixture.reference, '/stop'),
    headers: headers(), payload };
  const saved = await app.inject(request);
  expect(saved.statusCode).toBe(200);
  const stopReceipt = saved.json<{ sequence: number }>();
  const absent = envelope('test', fixture.event.subject, 'mcp.instance_observed',
    { ...observation, state: 'absent' });
  const stopped = await nats.store.append({ event: absent, expectedSequence: stopReceipt.sequence });
  if (stopped.status !== 'appended') throw new Error('Absence fixture failed');
  const next = envelope('test', fixture.event.subject, 'mcp.instance_start_requested',
    { ...fixture.data, runGeneration: 2, changeRef: `next-${counter}` });
  await nats.store.append({ event: next, expectedSequence: stopped.sequence });
  const retry = await app.inject(request);
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(saved.json());
  const original = await app.inject({ url: changeUrl(fixture.reference, payload.changeRef),
    headers: headers() });
  expect(original.json()).toEqual(saved.json());
  const stale = { ...payload, changeRef: `stale-${counter}` };
  const refused = await app.inject({ ...request, payload: stale });
  expect(refused.statusCode).toBe(409);
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(5);
}
it('derives the run and keeps the original receipt after a later run starts', retainsOriginalRun);
