import { encodeSession, type AuthConfig } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { fixture } from '@opencrane/models/testing';
import { Client } from 'minio/dist/esm/minio.mjs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { buildServer } from '../src/server.ts';

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
});
afterAll(async function stopServices() {
  await services.close();
});

function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
function scan() {
  return Promise.resolve('clean' as const);
}
function server(config: AuthConfig) {
  const chat = { silo: 'test', store: services.nats.store, db: services.db,
    binding: services.binding, keys: services.keys, feed: { memberId } };
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
