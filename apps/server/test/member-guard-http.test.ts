import { encodeSession, type AuthConfig } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { fixture } from '@opencrane/models/testing';
import { envelope } from '@opencrane/models';
import { createStore, memberAuthorisation, type Binding } from '@opencrane/authz';
import { conversations, members } from '@opencrane/projections';
import { Client } from 'minio/dist/esm/minio.mjs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.ts';
import { sameOrigin } from '../src/members/guard.ts';

const routes = [
  ['GET', '/api/chat'],
  ['GET', '/api/chat/colleagues'],
  ['GET', '/api/chat/groups'],
  ['GET', '/api/chat/groups/sales'],
  ['GET', '/api/conversations/conversation/changes/command'],
  ['GET', '/api/conversations'],
  ['POST', '/api/conversations'],
  ['GET', '/api/conversations/conversation/messages'],
  ['POST', '/api/conversations/conversation/messages'],
  ['GET', '/api/conversations/conversation/participants'],
  ['POST', '/api/conversations/conversation/participants'],
  ['GET', '/api/conversations/conversation/approvals'],
  ['POST', '/api/conversations/conversation/approvals'],
  ['GET', '/api/conversations/conversation/files'],
  ['POST', '/api/conversations/conversation/files'],
  ['GET', '/api/conversations/conversation/files/view?path=missing'],
] as const;
let services: Awaited<ReturnType<typeof fixture>>;
beforeAll(async function startServices() {
  services = await fixture();
  await services.runner.initialise(members);
  await services.runner.run(members);
  await services.runner.initialise(conversations);
  await services.runner.run(conversations);
});
afterAll(async function stopServices() {
  await services.close();
});

function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function scan() {
  function validate() {
    return 'clean' as const;
  }
  return Promise.resolve(validate);
}
function server(config: AuthConfig, binding: Binding = services.binding) {
  const chat = { silo: 'test', store: services.nats.store, db: services.db,
    binding, keys: services.keys, feed: { memberId } };
  const files = { ...chat, objects: new Client({ endPoint: '127.0.0.1' }), scan };
  return buildServer(config, { chat, files });
}
function headers(config: AuthConfig, orgId = 'org-test') {
  const session = { sub: 'alice', orgId, roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    origin: new URL(config.redirectUri).origin };
}

it.each(routes)('reports missing organisation setup on %s %s', async function check(method, url) {
  const config = testAuthConfig();
  const app = server(config);
  try {
    const request = { method, url, headers: headers(config), payload: {} };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable' });
    expect(response.headers['cache-control']).toContain('no-store');
  } finally {
    await app.close();
  }
});

it.each(routes)('refuses an unlisted identity on %s %s', async function check(method, url) {
  const config = testAuthConfig({ expectedOrgId: 'org-test',
    extraIdentities: [{ issuer: 'https://other.test', subject: 'alice' }] });
  const app = server(config);
  try {
    const request = { method, url, headers: headers(config, 'other-org'), payload: {} };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toContain('no-store');
  } finally {
    await app.close();
  }
});

it.each(routes)('refuses a session from another issuer on %s %s',
  async function check(method, url) {
    const config = testAuthConfig({ expectedOrgId: 'org-test' });
    const otherIssuer = { ...config, issuerUrl: 'https://other.test' };
    const app = server(config);
    try {
      const request = { method, url, headers: headers(otherIssuer), payload: {} };
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toContain('no-store');
    } finally {
      await app.close();
    }
  });

it('compares Origin with the configured website origin', function checkOrigin() {
  const config = testAuthConfig();
  const accepted = { headers: { origin: 'https://app.example.test' } };
  const refused = { headers: { origin: 'https://other.test' } };
  expect(sameOrigin(accepted, config)).toBe(true);
  expect(sameOrigin(refused, config)).toBe(false);
  expect(sameOrigin({ headers: {} }, config)).toBe(false);
});

it('refuses a configured silo that differs from an otherwise-authorised binding',
  async function refusesMismatchedSilo() {
    const config = testAuthConfig({ expectedOrgId: 'org-test' });
    const binding = await createStore(services.binding.apiUrl, 'other');
    const authorisation = memberAuthorisation(binding);
    const joined = envelope('other', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
    });
    await authorisation.handler.handle(joined, services.db);
    const allowedApp = server(config);
    const mismatchedApp = server(config, binding);
    const request = { url: '/api/chat/colleagues', headers: headers(config) };
    try {
      const allowed = await allowedApp.inject(request);
      expect(allowed.statusCode).toBe(200);
      const refused = await mismatchedApp.inject(request);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ status: 'refused' });
    } finally {
      await mismatchedApp.close();
      await allowedApp.close();
    }
  });

it('refuses cross-origin POST messages with an otherwise-valid message',
  async function refusesMessageOrigin() {
    const config = testAuthConfig({ expectedOrgId: 'org-test' });
    const app = server(config);
    const payload = { id: 'origin-message', text: 'Hello from this website' };
    const url = '/api/conversations/conversation/messages';
    const sessionHeaders = headers(config);
    const foreignHeaders = { ...sessionHeaders, origin: 'https://other.test' };
    try {
      const position = await services.nats.store.head('conversation-conversation');
      const refused = await app.inject({ method: 'POST', url, headers: foreignHeaders, payload });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ status: 'refused' });
      expect(await services.nats.store.head('conversation-conversation')).toBe(position);
      const allowed = await app.inject({ method: 'POST', url, headers: sessionHeaders, payload });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ status: 'appended' });
    } finally {
      await app.close();
    }
  });

it('refuses cross-origin POST participants with an otherwise-valid addition',
  async function refusesParticipantOrigin() {
    const config = testAuthConfig({ expectedOrgId: 'org-test' });
    const joined = await services.append('member-bob', 'member.joined', {
      memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
    });
    await services.auth.handler.handle(joined, services.db);
    await services.append('conversation-origin-group', 'conversation.created', {
      conversationId: 'origin-group', createdBy: 'alice', mode: 'group', participantIds: ['alice', 'bob'],
    });
    const target = await services.append('member-carol', 'member.joined', {
      memberId: 'carol', email: 'carol@example.test', displayName: 'Carol', role: 'member',
    });
    await services.auth.handler.handle(target, services.db);
    const app = server(config);
    const url = '/api/conversations/origin-group/participants';
    const payload = { id: 'origin-participant', action: 'add', participantId: 'carol',
      expectedAccessPosition: 0 };
    const sessionHeaders = headers(config);
    const foreignHeaders = { ...sessionHeaders, origin: 'https://other.test' };
    try {
      const read = await app.inject({ url, headers: sessionHeaders });
      expect(read.statusCode).toBe(200);
      payload.expectedAccessPosition = read.json<{ accessPosition: number }>().accessPosition;
      const position = await services.nats.store.head('participation-origin-group');
      const refused = await app.inject({ method: 'POST', url, headers: foreignHeaders, payload });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ status: 'refused' });
      expect(await services.nats.store.head('participation-origin-group')).toBe(position);
      const allowed = await app.inject({ method: 'POST', url, headers: sessionHeaders, payload });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ status: 'appended' });
    } finally {
      await app.close();
    }
  });


async function hidesHistoryFailureDetails() {
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  function failedLookup(): Promise<string> {
    return Promise.reject(new Error('protected-history-detail'));
  }
  vi.stubEnv('LOG_LEVEL', 'info');
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const chat = { silo: 'test', store: services.nats.store, db: services.db,
    binding: services.binding, keys: services.keys, feed: { memberId: failedLookup } };
  const logDestination = { write };
  const app = buildServer(config, { chat, logDestination });
  try {
    const request = { url: '/api/conversations/conversation/messages', headers: headers(config) };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('protected-history-detail');
    const logged = lines.join('\n');
    expect(logged).toContain('Chat request unavailable');
    expect(logged).not.toContain('protected-history-detail');
  } finally {
    await app.close();
    vi.unstubAllEnvs();
  }
}
it('keeps unexpected history failure details out of replies and logs', hidesHistoryFailureDetails);
