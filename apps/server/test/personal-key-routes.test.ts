import Fastify, { type FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { encodeSession } from '@opencrane/auth';
import { createLogger } from '@opencrane/observability';
import { expect, it, onTestFinished, vi } from 'vitest';
import { registerPersonalKeyRoutes } from '../src/integrations/personal-key-routes.ts';
import { registerPersonalConnectionNeeds } from '../src/integrations/personal-needs-route.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { personalKeyFixture } from './support/personal-key.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });

async function routeFixture() {
  const setup = await personalKeyFixture();
  const policy = await setup.publish();
  await setup.grant('alice');
  const logs: string[] = [];
  function write(line: string) { logs.push(line); }
  const loggerInstance: FastifyBaseLogger = createLogger('personal-key-test', { level: 'warn',
    destination: { write } });
  const app = Fastify({ loggerInstance });
  async function closeApp() { await app.close(); }
  onTestFinished(closeApp);
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject === 'signed-in' ? 'alice' : undefined);
  }
  function staged() {
    return Promise.resolve({ status: 'staged' as const,
      identity: { reference: 'fixture', uid: 'fixture', resourceVersion: '1' } });
  }
  const stage = vi.fn(staged);
  const options = { silo: 'test', binding: setup.binding, store: setup.nats.store, db: setup.db,
    feed: { memberId }, personalKeys: { custody: { stage }, db: setup.db,
      network: setup.remote.network } };
  registerPersonalKeyRoutes(app, config, options);
  registerPersonalConnectionNeeds(app, config, options);
  const session = { sub: 'signed-in', orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  function headers(patch: Partial<typeof session> = {}) {
    return { origin: 'https://app.example.test',
      cookie: `${config.cookieName}=${encodeSession(config, { ...session, ...patch })}` };
  }
  const payload = { action: 'create', connectionId: policy.connectionId,
    changeRef: randomUUID(), expectedSequence: 0, expectedGeneration: 0,
    material: setup.accounts[0].key };
  const path = `/api/my/tools/${setup.serverId}/profiles/personal/key`;
  return { setup, app, options, stage, headers, payload, path, logs };
}

async function refusesUntrustedRoutes(guard: string) {
  const test = await routeFixture();
  const headers = test.headers();
  let expected = 403;
  let reason = 'access_required';
  if (guard === 'session') {
    headers.cookie = '';
    expected = 401;
    reason = 'no_session';
  }
  if (guard === 'organisation') {
    Object.assign(headers, test.headers({ orgId: 'foreign' }));
    reason = 'wrong_organisation';
  }
  if (guard === 'origin') {
    headers.origin = 'https://foreign.example.test';
    reason = 'wrong_origin';
  }
  if (guard === 'silo') {
    test.options.silo = 'foreign';
    expected = 503;
    reason = 'wrong_silo';
  }
  if (guard === 'member') Object.assign(headers, test.headers({ sub: 'unresolved' }));
  const before = test.setup.remote.connections();
  const append = vi.spyOn(test.setup.nats.store, 'append');
  const historyRead = vi.spyOn(test.setup.nats.store, 'readStream');
  const query = vi.spyOn(test.setup.db, 'query');
  try {
    const reply = await test.app.inject({ method: 'POST', url: test.path,
      headers, payload: test.payload });
    expect(reply.statusCode, reply.body).toBe(expected);
    expect(reply.json()).toMatchObject({ reason });
    if (guard !== 'origin') {
      // Reads have no Origin requirement. Exercise both settings and needs routes.
      for (const url of [`/api/my/tools/${test.setup.serverId}/connection`,
        '/api/my/tools/needs?assistantId=assistant']) {
        const read = await test.app.inject({ method: 'GET', url, headers });
        let readStatus = expected;
        if (guard === 'silo' && url.includes('/needs?')) readStatus = 403;
        expect(read.statusCode, read.body).toBe(readStatus);
        expect(read.json()).toMatchObject({ reason });
      }
    }
    expect(test.stage).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(historyRead).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(test.setup.remote.connections()).toBe(before);
  } finally {
    append.mockRestore();
    historyRead.mockRestore();
    query.mockRestore();
  }
}
it.each(['session', 'organisation', 'origin', 'silo', 'member'])(
  'refuses HTTP %s failures before identity calls or custody writes', refusesUntrustedRoutes, 120_000);

async function classifiesFailureWithoutCredentials(failure: 'tls' | 'identity' | 'custody') {
  const test = await routeFixture();
  let expectedStatus = 422;
  let reason = 'identity_unverified';
  let diagnostic: string;
  if (failure === 'tls') {
    test.setup.remote.untrust();
    diagnostic = 'tls_untrusted';
  } else if (failure === 'identity') {
    test.payload.material = 'invalid-synthetic-key';
    diagnostic = 'invalid_reply';
  } else {
    expectedStatus = 503;
    reason = 'unavailable';
    diagnostic = 'connection_reset';
    function failedStage(): never {
      const cause = Object.assign(new Error(test.payload.material), { code: 'ECONNRESET' });
      throw new Error(`Private adapter ${test.payload.material}`, { cause });
    }
    test.stage.mockImplementation(failedStage);
  }
  const reply = await test.app.inject({ method: 'POST', url: test.path,
    headers: test.headers(), payload: test.payload });
  expect(reply.statusCode, reply.body).toBe(expectedStatus);
  expect(reply.json()).toMatchObject({ reason });
  const output = test.logs.join('\n');
  expect(output).toContain(diagnostic);
  expect(output + reply.body).not.toContain(test.payload.material);
  expect(output + reply.body).not.toContain(Buffer.from(test.payload.material).toString('base64'));
  expect(output).not.toContain('Private adapter');
}
it.each(['tls', 'identity', 'custody'] as const)(
  'classifies %s failure causes without logging credential-bearing messages',
  classifiesFailureWithoutCredentials, 120_000);

async function refusesInvalidRouteInput() {
  const test = await routeFixture();
  const before = test.setup.remote.connections();
  for (const url of [`/api/my/tools/${test.setup.serverId}/connection?owner=foreign`,
    '/api/my/tools/needs', '/api/my/tools/needs?assistantId=assistant&owner=foreign']) {
    const reply = await test.app.inject({ method: 'GET', url, headers: test.headers() });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({ status: 'refused', reason: 'invalid_input' });
  }
  for (const payload of [{ ...test.payload, material: 'has spaces' },
    { ...test.payload, material: 'a'.repeat(9000) }]) {
    const reply = await test.app.inject({ method: 'POST', url: test.path,
      headers: test.headers(), payload });
    const expected = payload.material.length > 8192 ? 413 : 400;
    expect(reply.statusCode).toBe(expected);
    expect(reply.json()).toEqual({ status: 'refused', reason: 'invalid_input' });
  }
  expect(test.stage).not.toHaveBeenCalled();
  expect(test.setup.remote.connections()).toBe(before);
}
it('gives malformed route inputs typed reasons before using a key', refusesInvalidRouteInput, 120_000);

async function keepsNeedsFailurePrivate() {
  const test = await routeFixture();
  const material = test.payload.material;
  const cause = Object.assign(new Error(`https://private.example.test/?key=${material}`),
    { code: 'ECONNREFUSED' });
  const failed = new Error(`Private lookup ${material}`, { cause });
  const lookup = vi.spyOn(test.options.feed, 'memberId').mockRejectedValue(failed);
  try {
    const reply = await test.app.inject({ method: 'GET',
      url: '/api/my/tools/needs?assistantId=assistant', headers: test.headers() });
    expect(reply.statusCode).toBe(503);
    expect(reply.json()).toEqual({ status: 'unavailable', reason: 'unavailable' });
    const output = test.logs.join('\n');
    expect(output).toContain('connection.needs');
    expect(output).toContain('connection_refused');
    expect(output + reply.body).not.toContain(material);
    expect(output).not.toContain('private.example.test');
    expect(output).not.toContain('Private lookup');
    expect(test.stage).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
}
it('classifies needs failures without exposing lookup messages', keepsNeedsFailurePrivate, 120_000);
